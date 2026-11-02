---
name: vision-tools
description: >-
  Native-first workflows for screenshot reconstruction, diagram extraction,
  screenshot-driven GUI work, long-screenshot OCR, and image processing
  (crops, pixel differences, palette measurements, SVG tracing, foreground
  extraction). Use when a task needs these workflows or concrete image
  artifacts; ordinary image questions can be answered with native vision.
---

# Vision tools

Use the main model's native vision first. The tools here supplement it with
image artifacts, measurements, or an optional separate-model opinion; they
are not a required route for seeing images.

## Workflow

1. Inspect the image natively and identify what the task requires. If you only
   have a description and need a missing detail, open the original image path.
   If the file is gone, report the missing evidence.
2. Zoom only when a relevant detail is unresolved. Crop that region and read
   the crop natively; use `ground` only if its estimated box would help locate
   the target. Stop inspecting once you have evidence for the requested answer.
3. Use local image processing for numerical claims or reusable artifacts.
   Treat model-generated boxes as estimates, not measured boundaries; verify
   their target and coordinate space before acting on them.
4. Verify the result against the task: readable text for OCR, nodes and edges
   for diagrams, the expected UI state after an action, or a rendered comparison
   for visual reconstruction. A low pixel-diff score alone is not correctness.

For browser or accessible GUI work, prefer DOM/accessibility information for
controls and state. Use screenshot coordinates when that information is
unavailable or the task specifically concerns appearance.

## Local tools: use when their output is needed

Resolve `scripts/` paths relative to this skill directory. Use `--help` for
additional options. These tools do not use the vision API; HTML rendering can
load resources referenced by the page.

| Need | Command |
| --- | --- |
| Reusable crop or close-up | `crop shot.png --region X1,Y1,X2,Y2 -o detail.png` |
| Locate pixel differences | `python3 scripts/pixel_diff.py before.png after.png` |
| Measure a region's palette | `python3 scripts/dominant_colors.py shot.png --region X1,Y1,X2,Y2` |
| Vectorize a flat graphic | `trace icon.png -o icon.svg` |
| Extract a transparent foreground | `python3 scripts/extract_fg.py shot.png --region X1,Y1,X2,Y2 -o icon.png` |
| Render an HTML file | `python3 scripts/html_shot.py page.html --width 1440 --height 900 -o page.png` |

- `crop --scale 4` enlarges a crop; it adds no missing detail. Coordinates
  measured on that output use the enlarged grid, not the original image.
- `pixel_diff` reports average intensity difference and ranked grid cells,
  not the fraction of changed pixels or a semantic comparison. It rescales a
  size-mismatched second image and reports that mismatch; match viewports
  before judging visual fidelity.
- `dominant_colors` clusters sampled pixels. `--candidates '#F9FAFA,#F5F5F5'`
  selects the closest supplied palette value; it does not recover original CSS.
- `trace` produces approximate vector paths from pixels, with filtering,
  scaling and curve fitting. It is not an exact size/offset measurement tool.
  It suits flat, high-contrast graphics; text becomes paths. Read the graphic
  playbook before shipping its output.
- `extract_fg` has manual-region and centered-icon auto modes. Inspect the
  alpha edges and complete foreground on light and dark backgrounds before use.

Use existing utilities when they fit. A small Pillow operation is also fine
when it is the simplest way to obtain an output these tools do not provide.

## Task playbooks: load only the matching one

| Task | Read |
| --- | --- |
| Long screenshot or chat-history transcription, chunking and boundary checks | `references/long-screenshot-ocr.md` |
| Rebuild or align a UI from a reference; fast approximation or close fidelity | `references/restore-ui.md` |
| Extract or rebuild an isolated graphic as PNG/SVG | `references/restore-graphic.md` |
| Convert a visual diagram into Mermaid, Graphviz or structured data | `references/restore-structure.md` |
| Operate a GUI from screenshots: calibrate, act, verify | `references/gui.md` |

## Optional model-backed CLIs

Use these only for a requested second opinion, a needed box/list contract,
scripted OCR, or a model without native image input. They send images to the
separately configured vision chain, not to the main agent model automatically.
Structured output does not guarantee better recognition or localization.

```bash
glance shot.png -q "Read the small status label."
glance shot.png --region X1,Y1,X2,Y2 --ocr
glance before.png after.png -q "What changed semantically?"
ground shot.png "the send button"
detect shot.png "buttons"
```

`ground` and `detect` return estimated boxes in original-image pixels, including
with `--region`. They can miss objects or select the wrong target, not just
round an edge incorrectly. `detect` is not an exhaustive inventory guarantee.
For multi-image questions, pass the images in one call so the model sees them
together. Native side-by-side inspection is also sufficient for semantic
comparison; use pixel diff when numerical differences matter.

The long-screenshot OCR script still uses `glance` for automated transcription.
Its `--split-only` mode makes chunks without API requests for native inspection.
Keep the `glance` client/config available if using the automated path.

### Configuration and failures

`extensions/vision-toolkit.json` under the Pi agent directory selects the CLI `model` and
`fallbacks`. For image-capable main models, `imagePolicy` defaults to `native`:
old and new images stay images, with no automatic description request.
`describe-old` and `describe` are legacy, explicit opt-ins for lossy image-to-text
conversion on supported connections. Text-only or unknown-capability models
still use the configured compatibility bridge. This policy does not route CLI
calls through the main model.

On a model-backed CLI configuration/API error, run `vision-doctor`. Use
`vision-doctor --smoke` only when a real diagnostic request is needed; it sends
a test image. Relay failures honestly. Continue with native inspection when
available; report if the scripted output cannot be produced. Keep provider
changes user-controlled: do not scrape credentials, hand-export secret overrides,
or silently switch to an unconfigured provider.

Local tools need their optional dependencies (Pillow, NumPy, vtracer or a
Chrome-family browser, depending on the tool). If a command is missing, use an
already available equivalent or report the missing capability; API diagnostics
do not fix local dependency errors.

## Image lifetime

Use temporary image paths directly for immediate inspection. Copy into durable
work storage only when the file must survive its owner or session, or be kept
with deliverables. Clipboard-image attachments are deleted at Pi session
shutdown; preserve them beforehand only if needed beyond that session.

Source: https://github.com/Anionex/agent-vision-toolkit
