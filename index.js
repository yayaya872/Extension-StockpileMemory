/**
 * Stockpile Memory — decoupled long-term memory for SillyTavern.
 *
 * Design (Marinara-style, decoupled):
 *  - Summaries are built incrementally in the background and STOCKPILED.
 *    Stockpiling never touches the prompt, so the prompt cache stays intact.
 *  - When the visible chat history reaches a token threshold, all stockpiled
 *    summaries are APPLIED at once: their source messages are flagged with
 *    ST's ignore symbol (excluded from the prompt) and the summary block is
 *    spliced into the outgoing chat by a generate_interceptor — i.e. into
 *    the exact array that gets sent, not a registration that can be wiped.
 *  - The injected summary block has a token budget. When it grows past the
 *    budget, the oldest applied summaries are consolidated into a single
 *    "chapter" summary in the background.
 *
 * Storage: settings in extensionSettings['stockpile_memory'],
 * per-chat data in chatMetadata['stockpile_memory'].
 */

const MODULE = 'stockpile_memory';
const LOG_PREFIX = '[StockpileMemory]';

function log(...args) { console.log(LOG_PREFIX, ...args); }
function warn(...args) { console.warn(LOG_PREFIX, ...args); }

const smErrors = [];
function noteError(where, e) {
    const msg = (e && e.message) ? e.message : String(e);
    smErrors.push(`${where}: ${msg}`);
    warn(where, e);
    reportDiag();
}
function reportDiag() {
    const el = document.getElementById('sm_diag');
    if (!el) return;
    const fabEl = document.getElementById('sm-fab');
    const sheetEl = smSheetEl;
    const wand = document.getElementById('sm-wand-entry') ? 'OK' : 'NG';
    let geo = '';
    try {
        if (fabEl) {
            const r = fabEl.getBoundingClientRect();
            const cs = getComputedStyle(fabEl);
            geo = ` | fabRect=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`
                + ` disp=${cs.display} vis=${cs.visibility} pos=${cs.position}`;
        }
        geo += ` | popup=${smPopupOpen ? 'open' : 'closed'}`;
        geo += ` | win=${window.innerWidth}x${window.innerHeight}`;
        if (window.visualViewport) geo += ` vv=${Math.round(window.visualViewport.width)}x${Math.round(window.visualViewport.height)}`;
    } catch { /* diag must never throw */ }
    el.textContent = `diag v1.1.1: fab=${fabEl ? 'OK' : 'NG'} sheet=${sheetEl ? 'OK' : 'NG'} wand=${wand}`
        + (smErrors.length ? ` | errors: ${smErrors.slice(-3).join(' ; ')}` : ' | errors: none')
        + geo;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Settings ────────────────────────────────────────────────────────────────

const defaultSettings = Object.freeze({
    enabled: true,
    autoApply: true,
    verbatimTurns: 10,          // newest assistant turns always kept raw
    turnsPerSummary: 3,         // assistant turns per stockpiled batch
    applyThresholdTokens: 12000, // visible-history tokens that trigger an apply
    memoryBudgetTokens: 3000,    // max tokens of the injected summary block
    summarizerResponseLength: 1000,
    connectionSource: 'default', // 'default' | 'profile' | 'openai' | 'ollama'
    profileId: '',
    openaiUrl: '',
    openaiKey: '',
    openaiModel: '',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',
    systemPrompt:
        'Role: precise narrative-state tracker. Output only the summary — no preamble, no commentary, no markdown.',
    userPrompt:
        `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context. If the passage_in_question has 2nd person point of view, 'you' in prose refers to the player. Use the player name in the summary output instead of 'you'.

Focus on: character interactions and relationship dynamics (including shifts in feelings, trust, suspicion or intimacy); decisions, promises and agreements; emotional beats and motivations; names, locations and time; plot developments and unresolved threads; details that distinguish this moment from any other.

Exclude anything insubstantial, fluff, or events already covered in prior_context.

Write in short phrases; output must be a single line:`,
    consolidateSystemPrompt:
        'Role: precise narrative-state tracker. Output only the merged summary — no preamble, no commentary, no markdown.',
    consolidateUserPrompt:
        `<summaries_to_merge>
{{summaries}}
</summaries_to_merge>

Merge these consecutive summaries into ONE shorter chapter summary. Preserve: names, relationship changes (feelings, trust, suspicion stages), promises and agreements, important decisions, injuries or lasting changes, and unresolved threads. Drop scene-level detail, dialogue specifics and atmosphere. Keep it noticeably shorter than the combined originals.

Write in short phrases; output must be a single paragraph:`,
    iconLeft: null,  // floating button position (px, viewport coords)
    iconTop: null,
});

function getSettings() {
    const ctx = SillyTavern.getContext();
    if (!ctx.extensionSettings[MODULE]) {
        ctx.extensionSettings[MODULE] = { ...defaultSettings };
    }
    const s = ctx.extensionSettings[MODULE];
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

function saveSettings() {
    try { SillyTavern.getContext().saveSettingsDebounced(); } catch (e) { /* noop */ }
}

// ─── Per-chat store ──────────────────────────────────────────────────────────
// store = {
//   items: [{ kind: 'batch'|'chapter', text, start, end, ts, covers? }],
//   summarizedUpTo: -1,  // chat index; items partition [0..summarizedUpTo]
//   appliedUpTo: -1,     // chat index; items with end <= appliedUpTo are live
// }

function getStore() {
    const ctx = SillyTavern.getContext();
    if (!ctx.chatMetadata) return null;
    if (!ctx.chatMetadata[MODULE]) {
        ctx.chatMetadata[MODULE] = { items: [], summarizedUpTo: -1, appliedUpTo: -1 };
    }
    const store = ctx.chatMetadata[MODULE];
    if (!Array.isArray(store.items)) store.items = [];
    if (!Number.isInteger(store.summarizedUpTo)) {
        store.summarizedUpTo = store.items.length ? store.items[store.items.length - 1].end : -1;
    }
    if (!Number.isInteger(store.appliedUpTo)) store.appliedUpTo = -1;
    if (store.appliedUpTo > store.summarizedUpTo) store.appliedUpTo = store.summarizedUpTo;
    return store;
}

let _saveStoreTimer = null;
function saveStore() {
    clearTimeout(_saveStoreTimer);
    _saveStoreTimer = setTimeout(() => {
        try { SillyTavern.getContext().saveChat(); } catch (e) { /* noop */ }
    }, 400);
}

function stockpiledItems(store) {
    return store.items.filter(it => it.end > store.appliedUpTo);
}
function appliedItems(store) {
    return store.items.filter(it => it.end <= store.appliedUpTo);
}

// ─── Turn bookkeeping ────────────────────────────────────────────────────────

function getAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        if (!m.mes || !m.mes.trim()) continue;
        turns.push({ index: i });
    }
    return turns;
}

/** Assistant turns that still need a summary (outside the keep window). */
function getEligibleTurns() {
    const s = getSettings();
    const store = getStore();
    const { chat } = SillyTavern.getContext();
    if (!store || !chat) return [];
    const all = getAssistantTurns(chat);
    const keepFrom = Math.max(0, all.length - s.verbatimTurns);
    const keep = new Set(all.slice(keepFrom).map(t => t.index));
    return all.filter(t => t.index > store.summarizedUpTo && !keep.has(t.index));
}

function playerName() {
    try { return SillyTavern.getContext().name1 || 'the player'; } catch (e) { return 'the player'; }
}

function buildPassage(start, end) {
    const { chat, name1, name2 } = SillyTavern.getContext();
    const parts = [];
    for (let i = start; i <= end && i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_system || !m.mes || !m.mes.trim()) continue;
        const name = m.name || (m.is_user ? name1 : name2);
        parts.push(`${name}: ${m.mes.trim()}`);
    }
    let text = parts.join('\n');
    const MAX = 16000;
    if (text.length > MAX) text = text.slice(0, MAX);
    return text;
}

/** Prior summaries as context for the next summarizer call (recent-biased). */
function buildContextStr() {
    const store = getStore();
    if (!store || store.items.length === 0) return '';
    const texts = store.items.map(it => it.text);
    let joined = texts.join('\n');
    const MAX = 6000;
    while (joined.length > MAX && texts.length > 1) {
        texts.shift();
        joined = texts.join('\n');
    }
    return joined;
}

// ─── Token estimation ────────────────────────────────────────────────────────

const _tokenCache = new Map(); // chat index -> { mes, tokens }
let lastTokenEstimate = -1;

function ignoreSymbol() {
    return SillyTavern.getContext().symbols.ignore;
}

async function estimateChatTokens() {
    try {
        const { chat, getTokenCountAsync } = SillyTavern.getContext();
        const IGNORE = ignoreSymbol();
        let total = 0;
        for (let i = 0; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg || !msg.mes) continue;
            if (msg.is_system) continue;
            if (msg.extra?.[IGNORE]) continue; // applied → not sent
            const cached = _tokenCache.get(i);
            if (cached && cached.mes === msg.mes) { total += cached.tokens; continue; }
            let tokens;
            try { tokens = await getTokenCountAsync(msg.mes, 0); }
            catch (e) { tokens = Math.ceil(msg.mes.length / 2); }
            _tokenCache.set(i, { mes: msg.mes, tokens });
            total += tokens;
        }
        lastTokenEstimate = total;
        return total;
    } catch (e) {
        return lastTokenEstimate;
    }
}

const _itemTokenCache = new Map(); // item text -> tokens
async function estimateItemsTokens(items) {
    const { getTokenCountAsync } = SillyTavern.getContext();
    let total = 0;
    for (const it of items) {
        if (_itemTokenCache.has(it.text)) { total += _itemTokenCache.get(it.text); continue; }
        let tokens;
        try { tokens = await getTokenCountAsync(it.text, 0); }
        catch (e) { tokens = Math.ceil(it.text.length / 2); }
        _itemTokenCache.set(it.text, tokens);
        total += tokens;
    }
    return total;
}

// ─── Summarizer calls ────────────────────────────────────────────────────────

let lastSummarizerError = '';

function extractText(res) {
    if (!res) return '';
    if (typeof res === 'string') return res;
    return res.content || res.text || res?.choices?.[0]?.message?.content || '';
}

async function callSummarizerOnce(systemPrompt, userPrompt) {
    const s = getSettings();
    const ctx = SillyTavern.getContext();

    switch (s.connectionSource) {
        case 'profile': {
            if (!s.profileId) throw new Error('No connection profile selected (Stockpile Memory settings)');
            const svc = ctx.ConnectionManagerRequestService;
            if (!svc || typeof svc.sendRequest !== 'function') {
                throw new Error('ConnectionManagerRequestService is not available in this SillyTavern version');
            }
            const res = await svc.sendRequest(s.profileId, [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ], { ignoreInstruct: true });
            return extractText(res);
        }
        case 'openai': {
            if (!s.openaiUrl || !s.openaiModel) throw new Error('OpenAI-compatible URL / model not set');
            const base = s.openaiUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
            const res = await fetch(`${base}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(s.openaiKey ? { 'Authorization': `Bearer ${s.openaiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: s.openaiModel,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    max_tokens: s.summarizerResponseLength || undefined,
                    stream: false,
                }),
            });
            if (!res.ok) throw new Error(`OpenAI-compatible endpoint returned HTTP ${res.status}`);
            const data = await res.json();
            return data?.choices?.[0]?.message?.content || '';
        }
        case 'ollama': {
            if (!s.ollamaModel) throw new Error('Ollama model not set');
            const base = (s.ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '');
            const res = await fetch(`${base}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: s.ollamaModel,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    stream: false,
                }),
            });
            if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
            const data = await res.json();
            return data?.message?.content || '';
        }
        default: {
            if (typeof ctx.generateRaw !== 'function') throw new Error('generateRaw is not available');
            const res = await ctx.generateRaw({
                prompt: userPrompt,
                systemPrompt: systemPrompt,
                responseLength: s.summarizerResponseLength || undefined,
            });
            return extractText(res);
        }
    }
}

function cleanSummaryText(raw) {
    if (!raw) return '';
    let t = String(raw);
    t = t.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
    t = t.replace(/```[a-z]*|```/g, '');
    t = t.split('\n').map(x => x.trim()).filter(Boolean).join(' ');
    return t.trim();
}

async function callSummarizer(systemPrompt, userPrompt) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const raw = await callSummarizerOnce(systemPrompt, userPrompt);
            const text = cleanSummaryText(raw);
            if (text) { lastSummarizerError = ''; return text; }
            lastSummarizerError = 'Summarizer returned an empty response';
        } catch (e) {
            lastSummarizerError = String(e?.message || e);
            warn('summarizer attempt failed:', e);
        }
        if (attempt === 0) await sleep(1500);
    }
    return '';
}

// ─── Stockpile ───────────────────────────────────────────────────────────────

let isWorking = false;

/** Summarize one batch of eligible turns into the stockpile. No prompt changes. */
async function stockpileOneBatch() {
    const s = getSettings();
    const store = getStore();
    if (!store) return false;
    const eligible = getEligibleTurns();
    if (eligible.length === 0) return false;

    const batch = eligible.slice(0, s.turnsPerSummary);
    const endIdx = batch[batch.length - 1].index;
    const startIdx = store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;

    if (startIdx > endIdx) {
        store.summarizedUpTo = endIdx;
        saveStore();
        return 'skip';
    }

    const storyTxt = buildPassage(startIdx, endIdx);
    if (!storyTxt.trim()) {
        store.summarizedUpTo = endIdx;
        saveStore();
        return 'skip';
    }

    const userPrompt = s.userPrompt
        .replaceAll('{{player_name}}', playerName())
        .replaceAll('{{context_str}}', buildContextStr() || '(none yet)')
        .replaceAll('{{story_txt}}', storyTxt);

    const summary = await callSummarizer(s.systemPrompt, userPrompt);
    if (!summary) return false;

    store.items.push({ kind: 'batch', text: summary, start: startIdx, end: endIdx, ts: Date.now() });
    store.summarizedUpTo = endIdx;
    saveStore();
    log(`Stockpiled batch [${startIdx}–${endIdx}] (${store.items.length} items total)`);
    return true;
}

/** Stockpile everything eligible (used by the "Summarize now" button). */
async function stockpileAll(onProgress) {
    if (isWorking) return;
    isWorking = true;
    try {
        let guard = 0;
        while (getEligibleTurns().length > 0 && guard++ < 200) {
            const r = await stockpileOneBatch();
            if (r === false) break; // summarizer failing — stop, keep progress
            if (onProgress) onProgress();
            updateUI();
        }
        await estimateChatTokens();
        if (getSettings().autoApply) await maybeApply();
        await maybeConsolidate();
    } finally {
        isWorking = false;
        updateUI();
    }
}

// ─── Apply ───────────────────────────────────────────────────────────────────

/** Flag every chat message covered by applied summaries with ST's ignore symbol. */
function markAppliedMessages() {
    const store = getStore();
    if (!store || store.appliedUpTo < 0) return;
    try {
        const { chat } = SillyTavern.getContext();
        const IGNORE = ignoreSymbol();
        for (let i = 0; i <= store.appliedUpTo && i < chat.length; i++) {
            const m = chat[i];
            if (!m || m.is_system) continue;
            if (!m.extra) m.extra = {};
            m.extra[IGNORE] = true;
        }
    } catch (e) {
        warn('markAppliedMessages error:', e);
    }
}

function unmarkAllMessages() {
    try {
        const { chat } = SillyTavern.getContext();
        const IGNORE = ignoreSymbol();
        for (const m of chat) {
            if (m?.extra && m.extra[IGNORE]) delete m.extra[IGNORE];
        }
    } catch (e) { /* noop */ }
}

/** Swap the stockpile into the prompt. Returns true if anything changed. */
function applyNow(manual = false) {
    const store = getStore();
    if (!store) return false;
    if (store.summarizedUpTo <= store.appliedUpTo) {
        if (manual) toastr.info('No stockpiled summaries waiting to be applied.', 'Stockpile Memory');
        return false;
    }
    const prev = store.appliedUpTo;
    store.appliedUpTo = store.summarizedUpTo;
    markAppliedMessages();
    saveStore();
    log(`Applied: appliedUpTo ${prev} → ${store.appliedUpTo}`);
    toastr.success(
        `Memory applied: summaries now cover the chat up to message ${store.appliedUpTo}. Originals are excluded from the prompt.`,
        'Stockpile Memory',
        { timeOut: 4000 }
    );
    return true;
}

async function maybeApply() {
    const s = getSettings();
    const store = getStore();
    if (!store) return;
    if (store.summarizedUpTo <= store.appliedUpTo) return;
    const tokens = lastTokenEstimate >= 0 ? lastTokenEstimate : await estimateChatTokens();
    if (tokens < 0 || tokens < s.applyThresholdTokens) return;
    log(`History ≈ ${tokens} tokens ≥ threshold ${s.applyThresholdTokens} — applying stockpile.`);
    applyNow(false);
}

// ─── Consolidation (chapter summaries) ───────────────────────────────────────

/**
 * If the applied (injected) summaries exceed the token budget, merge the
 * oldest applied items into a single chapter summary. Runs in the
 * background; at most 3 merges per cycle.
 */
async function maybeConsolidate() {
    const s = getSettings();
    const store = getStore();
    if (!store) return;

    for (let mergeRound = 0; mergeRound < 3; mergeRound++) {
        const applied = appliedItems(store);
        if (applied.length < 2) return;
        const tokens = await estimateItemsTokens(applied);
        if (tokens <= s.memoryBudgetTokens) return;

        // Applied items are always a prefix of store.items (ordered by end).
        const take = Math.min(6, applied.length);
        const group = store.items.slice(0, take);
        if (group.some(it => it.end > store.appliedUpTo)) return; // safety: prefix property broken

        const joined = group.map(it => it.text).join('\n');
        const userPrompt = s.consolidateUserPrompt.replaceAll('{{summaries}}', joined);
        const merged = await callSummarizer(s.consolidateSystemPrompt, userPrompt);
        if (!merged) return;

        const covers = group.reduce((acc, it) => acc + (it.covers || 1), 0);
        store.items.splice(0, take, {
            kind: 'chapter',
            text: merged,
            start: group[0].start,
            end: group[group.length - 1].end,
            ts: Date.now(),
            covers,
        });
        saveStore();
        log(`Consolidated ${take} items into a chapter [${group[0].start}–${group[group.length - 1].end}]`);
    }
}

// ─── Memory block + interceptor ──────────────────────────────────────────────

function assembleBlock(store) {
    const applied = appliedItems(store);
    if (applied.length === 0) return '';
    let chapterNo = 0;
    const lines = applied.map(it =>
        it.kind === 'chapter' ? `[Chapter ${++chapterNo}] ${it.text}` : it.text
    );
    return `<stockpile_memory>\n[Summary of earlier events in this conversation — treat this as established history.]\n${lines.join('\n')}\n</stockpile_memory>`;
}

/** Record of the most recent generation, shown in the UI as proof of injection. */
let lastGen = { at: 0, included: false, type: '' };

globalThis.stockpileMemoryInterceptor = async function (chatArray, _contextSize, _abort, type) {
    try {
        lastGen = { at: Date.now(), included: false, type: String(type || '') };
        const s = getSettings();
        if (!s.enabled) return;
        if (type === 'quiet' || type === 'impersonate') return;
        const store = getStore();
        if (!store || store.appliedUpTo < 0) return;
        const block = assembleBlock(store);
        if (!block) return;

        chatArray.splice(0, 0, {
            name: 'Stockpile Memory',
            is_user: false,
            is_system: false,
            send_date: Date.now(),
            mes: block,
            extra: { type: 'narrator' },
        });
        lastGen.included = true;
        setTimeout(updateUI, 50);
    } catch (e) {
        warn('interceptor error:', e);
    }
};

// ─── Background cycle + events ───────────────────────────────────────────────

async function backgroundCycle() {
    const s = getSettings();
    if (!s.enabled || isWorking) { updateUI(); return; }
    isWorking = true;
    try {
        await stockpileOneBatch();
        await estimateChatTokens();
        if (s.autoApply) await maybeApply();
        await maybeConsolidate();
    } catch (e) {
        warn('background cycle error:', e);
    } finally {
        isWorking = false;
        updateUI();
    }
}

function clampStoreToChat() {
    const store = getStore();
    const { chat } = SillyTavern.getContext();
    if (!store || !chat) return;
    const maxIdx = chat.length - 1;
    let changed = false;
    const before = store.items.length;
    store.items = store.items.filter(it => it.start <= maxIdx);
    if (store.items.length !== before) changed = true;
    if (store.summarizedUpTo > maxIdx) { store.summarizedUpTo = maxIdx; changed = true; }
    if (store.appliedUpTo > store.summarizedUpTo) { store.appliedUpTo = store.summarizedUpTo; changed = true; }
    if (changed) saveStore();
}

function onMessageReceived() {
    setTimeout(() => { backgroundCycle(); }, 350);
}

function onChatChanged() {
    setTimeout(async () => {
        clampStoreToChat();
        markAppliedMessages(); // ignore flags don't survive a reload — re-assert
        await estimateChatTokens();
        updateUI();
    }, 150);
}

async function clearMemory() {
    const store = getStore();
    if (!store) return;
    store.items = [];
    store.summarizedUpTo = -1;
    store.appliedUpTo = -1;
    unmarkAllMessages();
    saveStore();
    try { await SillyTavern.getContext().saveChat(); } catch (e) { /* noop */ }
    updateUI();
    toastr.success('Stockpile Memory cleared for this chat.', 'Stockpile Memory');
}

// ─── UI: floating button + summary sheet ─────────────────────────────────────

const RING_C = 2 * Math.PI * 20;

let smSheetEl = null;
let smPopupOpen = false;

function buildFabAndSheet() {
    buildSheetContent();
    if (document.getElementById('sm-fab')) return;

    const fab = document.createElement('div');
    fab.id = 'sm-fab';
    fab.title = 'Stockpile Memory';
    // Critical styles are inlined so the button is visible even if style.css
    // fails to load or is overridden by a theme.
    // Position is anchored from the top-left with viewport units, never with
    // bottom/right: ST sets perspective/transform on <html>, which makes it
    // the containing block for fixed elements, and on the phone layout that
    // block collapses so bottom-anchored elements render above the screen.
    fab.style.cssText = 'position:fixed;left:calc(100vw - 66px);top:calc(100vh - 148px);top:calc(100dvh - 148px);width:52px;height:52px;'
        + 'border-radius:50%;background:#22242c;box-shadow:0 2px 10px rgba(0,0,0,0.5);'
        + 'z-index:2147483647;display:block;visibility:visible;opacity:1;'
        + 'cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none;';
    fab.innerHTML = `
        <svg viewBox="0 0 48 48" class="sm-ring-svg" style="position:absolute;inset:2px;width:48px;height:48px;transform:rotate(-90deg);pointer-events:none">
            <circle class="sm-ring-bg" cx="24" cy="24" r="20" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="3.5"></circle>
            <circle class="sm-ring-fg" cx="24" cy="24" r="20" fill="none" stroke="#7bc47f" stroke-width="3.5" stroke-linecap="round"></circle>
        </svg>
        <span class="sm-fab-emoji" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:22px;pointer-events:none">🧠</span>
        <span class="sm-fab-badge" style="display:none;position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#e0a458;color:#1a1a1a;font-size:12px;font-weight:700;align-items:center;justify-content:center;pointer-events:none"></span>`;
    document.body.appendChild(fab);
    applyFabPosition();
    bindFabDrag(fab);

+ "'''" + ""}

// The summary sheet is a plain content element shown through SillyTavern's
// own Popup API. (A custom position:fixed sheet was displaced by exactly
// one viewport height on the user's phone — ST's popup system is the
// mobile-safe way to show overlay UI.)
function buildSheetContent() {
    if (smSheetEl) return smSheetEl;
    const el = document.createElement('div');
    el.className = 'sm-sheet-content';
    el.innerHTML = `
        <div class="sm-sheet-status"></div>
        <div class="sm-sheet-actions">
            <button class="sm-btn sm-act-apply" type="button">今すぐ反映</button>
            <button class="sm-btn sm-act-stockpile" type="button">要約を進める</button>
            <button class="sm-btn sm-act-clear sm-btn-danger" type="button">全てリセット</button>
        </div>
        <div class="sm-list"></div>`;
    bindListEvents(el);
    smSheetEl = el;
    return el;
}

function applyFabPosition() {
    const fab = document.getElementById('sm-fab');
    if (!fab) return;
    const s = getSettings();
    if (Number.isFinite(s.iconLeft) && Number.isFinite(s.iconTop)) {
        const w = fab.offsetWidth || 52;
        const h = fab.offsetHeight || 52;
        const ok = s.iconLeft > -w + 16 && s.iconLeft < window.innerWidth - 16
            && s.iconTop >= 0 && s.iconTop < window.innerHeight - 16;
        if (ok) {
            fab.style.left = `${s.iconLeft}px`;
            fab.style.top = `${s.iconTop}px`;
            fab.style.right = 'auto';
            fab.style.bottom = 'auto';
            return;
        }
        // Saved position is outside this viewport (e.g. saved on another
        // screen size, or a glitched drag): discard it.
        delete s.iconLeft;
        delete s.iconTop;
        saveSettings();
    }
    // Default spot: bottom-right, but expressed as a top-left anchor with
    // viewport units (see buildFabAndSheet — bottom anchoring breaks on the
    // phone layout because of ST's transformed <html> containing block).
    fab.style.left = 'calc(100vw - 66px)';
    fab.style.top = 'calc(100vh - 148px)';
    fab.style.top = 'calc(100dvh - 148px)';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
}

function bindFabDrag(fab) {
    let startX = 0, startY = 0, origLeft = 0, origTop = 0, dragging = false, moved = false;

    fab.addEventListener('pointerdown', (e) => {
        const rect = fab.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        origLeft = rect.left; origTop = rect.top;
        dragging = true; moved = false;
        fab.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    fab.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
        if (!moved) return;
        const w = fab.offsetWidth, h = fab.offsetHeight;
        const left = Math.min(Math.max(0, origLeft + dx), window.innerWidth - w);
        const top = Math.min(Math.max(0, origTop + dy), window.innerHeight - h);
        fab.style.left = `${left}px`;
        fab.style.top = `${top}px`;
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
    });
    fab.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        if (moved) {
            const rect = fab.getBoundingClientRect();
            const s = getSettings();
            s.iconLeft = Math.round(Math.min(Math.max(0, rect.left), window.innerWidth - fab.offsetWidth));
            s.iconTop = Math.round(Math.min(Math.max(0, rect.top), window.innerHeight - fab.offsetHeight));
            saveSettings();
        } else {
            openSheet();
        }
    });
}

function buildWandMenuEntry() {
    if (document.getElementById('sm-wand-entry')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const entry = document.createElement('div');
    entry.id = 'sm-wand-entry';
    entry.className = 'list-group-item flex-container flexGap5';
    entry.style.cursor = 'pointer';
    entry.innerHTML = '<div class="fa-solid fa-brain extensionsMenuExtensionButton"></div><span>Stockpile Memory</span>';
    entry.addEventListener('click', () => {
        openSheet();
        const btn = document.getElementById('extensionsMenuButton');
        if (btn) btn.click();
    });
    menu.appendChild(entry);
}

function openSheet() {
    if (smPopupOpen) return;
    const el = buildSheetContent();
    updateUI();
    try {
        const ctx = SillyTavern.getContext();
        smPopupOpen = true;
        const popup = new ctx.Popup(el, ctx.POPUP_TYPE.TEXT, '', {
            wide: true,
            large: true,
            okButton: '閉じる',
            allowVerticalScrolling: true,
            onClose: () => { smPopupOpen = false; },
        });
        popup.show();
    } catch (e) {
        smPopupOpen = false;
        noteError('openSheet/popup', e);
        toastr.error('Stockpile Memory: ポップアップを開けませんでした。');
    }
}

function formatDate(ts) {
    try {
        const d = new Date(ts);
        return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } catch (e) { return ''; }
}

function originalHtml(item) {
    const { chat, name1, name2 } = SillyTavern.getContext();
    const parts = [];
    for (let i = item.start; i <= item.end && i < chat.length; i++) {
        const m = chat[i];
        if (!m || !m.mes) continue;
        const name = m.name || (m.is_user ? name1 : name2);
        parts.push(`<div class="sm-orig-msg"><div class="sm-orig-name">${escapeHtml(name)}</div><div class="sm-orig-text">${escapeHtml(m.mes)}</div></div>`);
    }
    return parts.join('') || '<div class="sm-empty">原文が見つかりませんでした</div>';
}

function renderList() {
    const list = smSheetEl ? smSheetEl.querySelector('.sm-list') : null;
    if (!list) return;
    const store = getStore();
    if (!store || store.items.length === 0) {
        list.innerHTML = '<div class="sm-empty">このチャットの要約はまだありません</div>';
        return;
    }
    let chapterNo = 0;
    let seenChapter = false;
    list.innerHTML = store.items.map((it, idx) => {
        const isChapter = it.kind === 'chapter';
        if (isChapter) { chapterNo++; seenChapter = true; }
        const applied = it.end <= store.appliedUpTo;
        const badge = applied
            ? '<span class="sm-badge sm-badge-live">✅ 反映中</span>'
            : '<span class="sm-badge sm-badge-stock">📦 備蓄中</span>';
        const title = isChapter ? `📖 第${chapterNo}章` : '要約';
        const covers = isChapter && it.covers ? `（${it.covers}件を統合）` : '';
        const cls = ['sm-item', isChapter ? 'sm-item-chapter' : '', (!isChapter && seenChapter) ? 'sm-item-nested' : ''].join(' ');
        return `
        <div class="${cls}" data-idx="${idx}">
            <div class="sm-item-head">
                <span class="sm-item-title">${title}</span>${badge}
                <span class="sm-item-meta">msg ${it.start}–${it.end}${covers} · ${formatDate(it.ts)}</span>
            </div>
            <div class="sm-item-text">${escapeHtml(it.text)}</div>
            <div class="sm-item-detail" hidden>
                <div class="sm-item-btns">
                    <button class="sm-btn sm-orig-btn" type="button">原文を見る</button>
                    <button class="sm-btn sm-edit-btn" type="button">編集する</button>
                </div>
                <div class="sm-orig" hidden></div>
                <div class="sm-editbox" hidden>
                    <textarea class="sm-edit-text" rows="4">${escapeHtml(it.text)}</textarea>
                    <div class="sm-item-btns">
                        <button class="sm-btn sm-save-btn" type="button">保存</button>
                        <button class="sm-btn sm-cancel-btn" type="button">キャンセル</button>
                    </div>
                </div>
            </div>
        </div>`;
    }).join('');
}

function bindListEvents(sheet) {
    const list = sheet.querySelector('.sm-list');
    list.addEventListener('click', async (e) => {
        const itemEl = e.target.closest('.sm-item');
        if (!itemEl) return;
        const idx = parseInt(itemEl.dataset.idx, 10);
        const store = getStore();
        if (!store || !store.items[idx]) return;
        const item = store.items[idx];

        if (e.target.closest('.sm-item-head')) {
            const detail = itemEl.querySelector('.sm-item-detail');
            detail.hidden = !detail.hidden;
            return;
        }
        if (e.target.closest('.sm-orig-btn')) {
            const orig = itemEl.querySelector('.sm-orig');
            if (orig.hidden && !orig.dataset.loaded) {
                orig.innerHTML = originalHtml(item);
                orig.dataset.loaded = '1';
            }
            orig.hidden = !orig.hidden;
            return;
        }
        if (e.target.closest('.sm-edit-btn')) {
            itemEl.querySelector('.sm-editbox').hidden = false;
            return;
        }
        if (e.target.closest('.sm-cancel-btn')) {
            itemEl.querySelector('.sm-editbox').hidden = true;
            return;
        }
        if (e.target.closest('.sm-save-btn')) {
            const ta = itemEl.querySelector('.sm-edit-text');
            const newText = ta.value.trim();
            if (newText && newText !== item.text) {
                item.text = newText;
                _itemTokenCache.delete(item.text);
                saveStore();
                toastr.success('要約を更新しました', 'Stockpile Memory');
            }
            renderList();
            updateUI();
            return;
        }
    });
}

function statusText() {
    const store = getStore();
    if (!store) return 'チャットが開かれていません';
    const applied = appliedItems(store).length;
    const stock = stockpiledItems(store).length;
    const tok = lastTokenEstimate >= 0 ? `履歴 ≈ ${lastTokenEstimate} tok` : '履歴 ≈ ? tok';
    const gen = !lastGen.at ? '前回生成: —' : (lastGen.included ? '前回生成: 要約あり ✓' : '前回生成: 要約なし');
    const work = isWorking ? ' · 要約を作成中…' : '';
    const err = lastSummarizerError ? ` · ⚠️ ${lastSummarizerError}` : '';
    return `${tok} ／ 反映済み ${applied}件 ／ 備蓄中 ${stock}件 ／ ${gen}${work}${err}`;
}

function updateFab() {
    const fab = document.getElementById('sm-fab');
    if (!fab) return;
    const s = getSettings();
    const ring = fab.querySelector('.sm-ring-fg');
    if (ring) {
        const frac = (s.applyThresholdTokens > 0 && lastTokenEstimate >= 0)
            ? Math.min(1, lastTokenEstimate / s.applyThresholdTokens) : 0;
        ring.style.strokeDasharray = String(RING_C);
        ring.style.strokeDashoffset = String(RING_C * (1 - frac));
        ring.style.stroke = frac >= 1 ? '#e06c5f' : (frac >= 0.7 ? '#e0a458' : '#7bc47f');
    }
    const badge = fab.querySelector('.sm-fab-badge');
    const store = getStore();
    const n = store ? stockpiledItems(store).length : 0;
    if (badge) {
        badge.style.display = n > 0 ? 'flex' : 'none';
        badge.textContent = String(n);
    }
    fab.style.opacity = s.enabled ? '1' : '0.45';
}

function updateUI() {
    try {
        updateFab();
        const text = statusText();
        const sheetStatus = smSheetEl ? smSheetEl.querySelector('.sm-sheet-status') : null;
        if (sheetStatus) sheetStatus.textContent = text;
        const panelStatus = document.getElementById('sm_status');
        if (panelStatus) panelStatus.textContent = text;
        if (smSheetEl) renderList();
    } catch (e) { /* UI is best-effort */ }
}

// ─── Actions (shared by sheet + settings panel) ──────────────────────────────

function bindActions() {
    $(document).on('click', '.sm-act-open', function () {
        openSheet();
    });
    $(document).on('click', '.sm-act-apply', async function () {
        if (applyNow(true)) {
            await maybeConsolidate();
        }
        updateUI();
    });
    $(document).on('click', '.sm-act-stockpile', async function () {
        if (isWorking) { toastr.info('Working… please wait.', 'Stockpile Memory'); return; }
        toastr.info('Stockpiling summaries in the background…', 'Stockpile Memory');
        await stockpileAll();
        if (lastSummarizerError) {
            toastr.error(`Summarizer error: ${lastSummarizerError}`, 'Stockpile Memory');
        }
    });
    $(document).on('click', '.sm-act-clear', async function () {
        if (!confirm('Clear ALL Stockpile Memory summaries for this chat? Original messages will be sent to the LLM again.')) return;
        await clearMemory();
    });
}

// ─── Settings panel ──────────────────────────────────────────────────────────

function populateProfiles() {
    const select = document.getElementById('sm_profile');
    if (!select) return;
    try {
        const svc = SillyTavern.getContext().ConnectionManagerRequestService;
        if (svc && typeof svc.handleDropdown === 'function') {
            svc.handleDropdown(select);
            const s = getSettings();
            if (s.profileId) select.value = s.profileId;
        }
    } catch (e) { warn('populateProfiles failed:', e); }
}

function syncSourcePanels() {
    const s = getSettings();
    const map = { profile: 'sm_profile_wrap', openai: 'sm_openai_wrap', ollama: 'sm_ollama_wrap' };
    for (const [key, id] of Object.entries(map)) {
        const el = document.getElementById(id);
        if (el) el.style.display = (s.connectionSource === key) ? 'block' : 'none';
    }
    if (s.connectionSource === 'profile') populateProfiles();
}

function syncSettingsForm() {
    const s = getSettings();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    chk('sm_enabled', s.enabled);
    chk('sm_auto_apply', s.autoApply);
    set('sm_verbatim', s.verbatimTurns);
    set('sm_batch', s.turnsPerSummary);
    set('sm_threshold', s.applyThresholdTokens);
    set('sm_budget', s.memoryBudgetTokens);
    set('sm_resp_len', s.summarizerResponseLength);
    set('sm_source', s.connectionSource);
    set('sm_oai_url', s.openaiUrl);
    set('sm_oai_key', s.openaiKey);
    set('sm_oai_model', s.openaiModel);
    set('sm_ollama_url', s.ollamaUrl);
    set('sm_ollama_model', s.ollamaModel);
    set('sm_sys_prompt', s.systemPrompt);
    set('sm_user_prompt', s.userPrompt);
    set('sm_consol_prompt', s.consolidateUserPrompt);
    syncSourcePanels();
}

function bindSettings() {
    const num = (id, key) => {
        $(document).on('input', `#${id}`, function () {
            const v = parseInt($(this).val(), 10);
            if (Number.isFinite(v) && v >= 0) { getSettings()[key] = v; saveSettings(); updateUI(); }
        });
    };
    const txt = (id, key) => {
        $(document).on('input', `#${id}`, function () {
            getSettings()[key] = $(this).val();
            saveSettings();
        });
    };
    $(document).on('change', '#sm_enabled', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettings(); updateUI();
    });
    $(document).on('change', '#sm_auto_apply', function () {
        getSettings().autoApply = $(this).prop('checked');
        saveSettings();
    });
    num('sm_verbatim', 'verbatimTurns');
    num('sm_batch', 'turnsPerSummary');
    num('sm_threshold', 'applyThresholdTokens');
    num('sm_budget', 'memoryBudgetTokens');
    num('sm_resp_len', 'summarizerResponseLength');
    txt('sm_oai_url', 'openaiUrl');
    txt('sm_oai_key', 'openaiKey');
    txt('sm_oai_model', 'openaiModel');
    txt('sm_ollama_url', 'ollamaUrl');
    txt('sm_ollama_model', 'ollamaModel');
    txt('sm_sys_prompt', 'systemPrompt');
    txt('sm_user_prompt', 'userPrompt');
    txt('sm_consol_prompt', 'consolidateUserPrompt');
    $(document).on('change', '#sm_source', function () {
        getSettings().connectionSource = $(this).val();
        saveSettings();
        syncSourcePanels();
    });
    $(document).on('change', '#sm_profile', function () {
        getSettings().profileId = $(this).val();
        saveSettings();
    });
}

// ─── Init ────────────────────────────────────────────────────────────────────

jQuery(async () => {
    const ctx = SillyTavern.getContext();
    try {
        const html = await ctx.renderExtensionTemplateAsync('third-party/Extension-StockpileMemory', 'settings');
        $('#extensions_settings2').append(html);
    } catch (e) {
        warn('settings template failed to load:', e);
    }
    try { buildFabAndSheet(); } catch (e) { noteError('buildFabAndSheet', e); }
    try { buildWandMenuEntry(); } catch (e) { noteError('buildWandMenuEntry', e); }
    try { bindSettings(); } catch (e) { noteError('bindSettings', e); }
    try { bindActions(); } catch (e) { noteError('bindActions', e); }
    try { syncSettingsForm(); } catch (e) { noteError('syncSettingsForm', e); }
    // Watchdog: if ST's own startup (or a theme/layout rebuild) removes the
    // injected UI elements, recreate them. Runs for the first minute.
    let smWatchTries = 0;
    const smWatch = setInterval(() => {
        smWatchTries++;
        if (!document.getElementById('sm-fab')) {
            try { buildFabAndSheet(); } catch (e) { noteError('watchdog/buildFabAndSheet', e); }
        }
        if (!document.getElementById('sm-wand-entry')) {
            try { buildWandMenuEntry(); } catch (e) { /* menu may not exist yet */ }
        }
        reportDiag();
        if (smWatchTries >= 60) clearInterval(smWatch);
    }, 1000);
    reportDiag();
    ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, onMessageReceived);
    ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, onChatChanged);
    onChatChanged();
    log('initialized');
});
