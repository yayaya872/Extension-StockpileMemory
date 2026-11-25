# Stockpile Memory

Decoupled long-term memory for SillyTavern (Marinara-style).

## How it works

1. **Stockpile** — After each reply, a few old turns are summarized in the
   background and stockpiled. The prompt is *not* touched, so the prompt
   cache stays intact and the originals keep being sent word-for-word.
2. **Apply** — When the visible chat history reaches a token threshold
   (default 12,000), all stockpiled summaries are swapped in at once:
   their source messages are excluded from the prompt (via SillyTavern's
   ignore symbol) and the summary block is spliced into the exact chat
   array being sent by a `generate_interceptor`. One cache break, at the
   moment you chose.
3. **Consolidate** — The injected summary block has a token budget
   (default 3,000). When applied summaries grow past it, the oldest ones
   are merged into a single "chapter" summary in the background, so total
   memory stays bounded no matter how long the chat runs.

## UI

- A draggable 🧠 button floats over the chat. Its ring shows how close
  the history is to the apply threshold; the badge counts stockpiled
  summaries. Tap it to open the summary sheet.
- The sheet lists every summary like a table of contents — chapters as
  headings, each entry badged ✅ IN PROMPT / 📦 STOCKPILED. Tap an entry
  to read the original messages it covers, or edit the summary text.
- The sheet header reports whether the last generation actually included
  the memory block.
- On phones, the 🧠 button is anchored from the top of the screen with
  viewport units (v1.1.1+). SillyTavern sets a transform on `<html>` that
  breaks bottom-anchored `position: fixed` elements on mobile layouts,
  which previously pushed the button off-screen.

## Settings

Verbatim keep window, batch size, apply threshold, memory budget, and the
summarizer connection (Main API / Connection Profile / OpenAI-compatible /
Ollama) are in the extension settings drawer.

## Notes

- Per-chat data lives in `chatMetadata['stockpile_memory']`; nothing is
  written into message text. Disabling or removing the extension leaves
  the chat untouched (the ignore flags are in-memory only and are
  re-asserted from the stored state when the chat loads).
