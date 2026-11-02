# OCR a long screenshot without losing boundary text

**Use for**: a vertically scrolling screenshot, chat history, long web page,
requirements conversation, log view, or other image that would be downscaled too
aggressively in one vision call. For a PDF or an exported document, prefer a
format-aware document parser instead of screenshot OCR.

## Run the workflow

Read the source at its current path; copy it only when it needs to persist
beyond a temporary file's lifetime. Inspect the script's help before choosing
options:

```bash
python3 scripts/long_screenshot_ocr.py --help
```

Prefer native chunk reading by the main agent; the glance-backed script is
available for automated transcription. Both paths use the same content-aware
splitter; verify joins even when the cut falls in a low-content band.

### Native chunk reading

```bash
python3 scripts/long_screenshot_ocr.py work/page.png --split-only
```

This writes ordered chunk images and `manifest.json` without vision calls.
Read the chunks natively in manifest order and assemble `work/page.ocr.md`.
For unresolved text, crop the relevant region and read it natively. Verify
every join against both adjacent images, removing only confirmed overlap;
preserve chat senders, timestamps, and quoted messages. Split-only does not
produce merged OCR or `ocr_audit.md`, so record uncertain joins in the output.

### Automated transcription with glance

Choose the content mode; this path makes configured vision calls:

```bash
# Web pages, documents, logs, tables, and other general content
python3 scripts/long_screenshot_ocr.py work/page.png -o work/page.ocr.md

# Chat histories: preserve message grouping, senders, timestamps, and quotes
python3 scripts/long_screenshot_ocr.py work/chat.png --mode chat -o work/chat.ocr.md
```

Without `-o`, write `<input-stem>.ocr.md`; store chunks, sidecars, the manifest,
and the audit in `<input-stem>_chunks/` unless `--chunks-dir` overrides it.

The script performs four operations:

1. Measure per-row content density and find low-content cut bands near the
   target height.
2. Add pixel overlap only when no safe band exists, so text crossing a risky
   cut appears in both adjacent chunks.
3. Run `glance` on the chunks through the configured `vision-toolkit.json`
   chain (or legacy `VISION_*` settings); chat mode requests structured messages
   while general mode uses verbatim OCR.
4. Merge only confident repeated lines or messages and write `manifest.json` plus
   `ocr_audit.md` beside the chunks.

Use `--resume` after an interrupted run. A chunk is reused only when its image,
mode, and custom prompt fingerprint still match:

```bash
python3 scripts/long_screenshot_ocr.py work/chat.png --mode chat --resume -o work/chat.ocr.md
```

If the defaults produce awkward chunks, rerun with `--target-height`,
`--min-height`, `--max-height`, or `--overlap`. Keep enough height for local
context; do not make tiny OCR tiles unless the source text is unusually small.

## Verify before delivering

1. Read the merged Markdown from top to bottom and compare its opening and
   ending lines with the source.
2. For automated transcription, open `ocr_audit.md` and review every boundary
   marked `yes` against the two adjacent `chunk_*.png` files. A marked boundary
   used pixel overlap or fuzzy text matching and is not safe to accept blindly.
   For native chunk reading, verify every join against adjacent images and the
   manifest; no automated merge audit is generated.
3. Check sender changes, timestamps, quoted messages, table row breaks, code
   indentation, and paragraphs that cross chunk boundaries.
4. For doubtful text, crop and read the region natively. If it remains
   unresolved, targeted specialist OCR is available:

   ```bash
   glance work/page_chunks/chunk_002.png --ocr "Re-check the final five lines carefully."
   glance work/page_chunks/chunk_002.png --region X1,Y1,X2,Y2 --ocr
   ```

5. Keep visible spelling and punctuation verbatim. Write `[unreadable]` for
   text that remains illegible; do not silently guess or editorially repair it.

## Output contract

- Return the merged `.ocr.md` file as the primary result.
- Keep the chunk directory until verification is complete; it is the evidence
  for ordering and boundary decisions.
- Report unresolved `[unreadable]` text and every boundary that still needs
  human review.
- Do not claim a complete transcription when the first or last screenshot edge
  visibly clips content.
