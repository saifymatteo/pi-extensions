# Rebuilding a UI from a reference image

**When to use**: the task is turning a screenshot or design image into a
page, component, or application UI in HTML/CSS or the project's existing
frontend stack. Checking an existing implementation against its reference is
the same workflow entered at Verify. For an isolated icon, logo, or
illustration, read `restore-graphic.md`; for Mermaid, Graphviz, or another
structured diagram, read `restore-structure.md`.

## Choose the restore mode

- Use **fast restore mode** when the user asks for a quick, rough,
  approximate, prototype, or first-pass reconstruction, or explicitly values
  speed over fidelity. Its target is a recognizable screenshot in about three
  minutes when the project already runs.
- Use the **standard restore workflow** below when the user asks for close,
  precise, pixel-level, or production-ready alignment, or does not opt into a
  faster approximation.

## Fast restore mode: first screenshot in about three minutes

Fast mode preserves the page's hierarchy, major regions, visible text, and
primary state. It deliberately approximates fine spacing, exact colors,
typography, shadows, decorative details, and icon geometry.

### Hard limits

1. Inspect the existing frontend stack, component library, icon set, source
   assets, and design tokens before writing code, but stop searching as soon as
   a usable local primitive is found.
2. Inspect the reference natively with the main agent's image reader for
   hierarchy, major regions, visible text, and state. Crop and read a region
   natively only when a material detail remains unresolved; skip exhaustive
   region-by-region inventory. Normally one or two inspection rounds suffice.
3. Do not use `trace`, foreground extraction, repeated color sampling, or
   iterative `pixel_diff` work in fast mode. Those are fidelity tools and will
   consume the delivery window.

### Build the approximation

1. Implement the largest layout regions first, then visible text, primary
   controls, and the most important state. Ignore details that are only visible
   when zoomed in.
2. Reuse the project's existing components and CSS tokens. If its frontend or
   icon library contains a reasonably similar component or icon, use it
   directly instead of recreating the reference. Prefer an approximate library
   icon over cropping, tracing, or hand-drawing a new one.
3. Use nearby existing palette tokens or visually similar CSS values. Exact
   sampled hex values, gradients, subtle borders, and shadow opacity are out of
   scope unless one of them defines the whole composition.
4. Keep text and controls native, selectable, and interactive. Fast mode relaxes
   visual fidelity, not basic UI behavior.

### Render once, fix once, deliver

1. Render the target viewport with `scripts/html_shot.py` or the project's
   existing browser setup.
2. Inspect the screenshot once. If there is an obvious structural failure such
   as a missing major region, broken wrapping, or a wildly wrong scale, make
   one focused correction and render once more.
3. Deliver the screenshot. Stop instead of spending the remaining time on
   small color, icon, font, shadow, radius, or spacing differences.

A practical time box is roughly 30 seconds for project and native image
inspection, 90 seconds for implementation, and the remaining minute for startup,
rendering, one correction, and screenshot delivery. Dependency installation or
a project that does not already run may extend that target; do not compensate
by silently switching back to a long precision loop.

## Standard restore workflow

### Core strategy: code-native UI plus screenshot-backed visuals

Do not choose one reconstruction mode for the whole page. Classify each
element separately. Most finished pages should combine both kinds:

| Kind | Build it this way | Typical examples |
|---|---|---|
| **Code-native component** | Reuse the project's component library or build it with semantic HTML, CSS, and simple SVG primitives | layout, text, buttons, inputs, cards, tabs, dividers, backgrounds, simple geometric badges |
| **Screenshot-backed visual** | Extract the original pixels, remove the background when needed, and place the result as an image asset | logos, proprietary icons, illustrations, decorative artwork, textures, complex static marks |

Use this decision order for every element:

1. **Reuse an existing component or source asset from the project.** Search
   before recreating anything.
2. **Use a code-native component** when the element contains text, accepts
   input, changes state, must respond to layout, or is simple to express with
   the project's normal primitives.
3. **Use a screenshot-backed visual** when it is static, visually distinctive,
   expensive to redraw, and no source asset exists.
4. Rebuild a vector only when the user requires SVG/editability, the visual
   must scale beyond the screenshot resolution, or extraction cannot isolate
   it cleanly. Follow `restore-graphic.md` for that branch. `trace` provides
   approximate vectorization, not exact geometric measurement.

Never flatten text, controls, or a large layout block into a screenshot. Never
redraw extractable brand artwork merely to make the implementation look more
"native". For a complex widget, keep the shell, text, and interaction native;
use an extracted image only for its static decorative layer.

## Steps

### 1. Inspect the reference and target project

Read the reference directly at its current path. Copy it to durable work
storage only when it must persist beyond the temporary file's lifetime.
Inspect the existing stack, component library, fonts, icons, images, and
design tokens before writing replacements.

### 2. Establish the coordinate system

Record the reference image dimensions and the target viewport. Screenshots may
be HiDPI: `detect`, `ground`, and `crop` report image pixels, while CSS uses
logical pixels. Derive the scale from the actual image and viewport dimensions;
do not assume a fixed 2x ratio.

### 3. Inventory the UI outside-in

1. Inspect the image natively for hierarchy, component types, visible text,
   state, and styling; list the major regions outside-in.
2. For unresolved details, crop the relevant region and read it natively.
3. Use specialist tools only for a remaining concrete need: `detect` for an
   inventory, `glance` for a second opinion or OCR, `ground` for a target box.

Model boxes are estimates and can identify the wrong element or miss large
parts of it. Verify them against the pixels before using them for crops or
layout; they are not measured boundaries.

### 4. Classify before implementing

Make a short element list with one of these decisions: reuse existing source,
code-native, screenshot-backed, or hybrid. This prevents two costly mistakes:
rebuilding complex artwork from scratch and turning functional UI into static
image patches.

### 5. Extract screenshot-backed visuals

Use a padded crop only to inspect and center the target. Before foreground
extraction, tighten the final region to the visual's own ink; adjacent text or
rules inside the region can become foreground components too.

```bash
python3 "<skill-dir>/bin/crop" shot.png --region X1,Y1,X2,Y2 --scale 4 -o work/icon4x.png
python3 "<skill-dir>/scripts/extract_fg.py" work/icon4x.png

# Or extract directly from a known tight region:
python3 "<skill-dir>/scripts/extract_fg.py" shot.png \
  --region X1,Y1,X2,Y2 -o work/icon.png
python3 "<skill-dir>/scripts/extract_fg.py" shot.png \
  --region X1,Y1,X2,Y2 --mode dark -o work/logo.png
```

Inspect the transparent result before use. Confirm that the whole visual is
present, no neighboring text or border leaked in, and the alpha edge remains
clean. When extracting several assets, inspect them together in a contact
sheet instead of checking them from filenames alone.

### 6. Implement the native frame

- Follow the project's existing framework and component patterns.
- Build content, interaction, responsive layout, borders, shadows, and simple
  shapes natively.
- Use `scripts/dominant_colors.py` when exact background, text, or accent
  values matter; visual inspection can name a color but cannot measure its
  numeric value.
- Place extracted assets with explicit logical dimensions. Preserve their
  aspect ratio and avoid baking surrounding whitespace into the asset.
- Match structure and proportions before tuning small spacing.

## Verify and converge by impact

For an existing implementation, start here.

1. Render at the same logical viewport with `scripts/html_shot.py` or the
   project's browser test setup.
2. Compare the render and reference at the same dimensions. Inspect them side
   by side; use `scripts/pixel_diff.py` to locate differences that are hard to
   spot or explain.
3. Fix material discrepancies: missing or wrong content, incorrect hierarchy,
   broken wrapping, visibly wrong alignment or scale, wrong component state,
   distorted assets, and clearly different primary colors.
4. Re-render after a meaningful fix. Continue while the comparison exposes a
   user-visible defect; stop when the remaining difference is font
   rasterization, antialiasing, subpixel placement, or another imperceptible
   rendering detail.

`pixel_diff` is a locator, not the acceptance target. Do not keep iterating only
to lower its aggregate percentage, and do not promise zero-difference output
from a screenshot without a separately scoped browser, font, viewport, and
rendering environment.

## Boundaries

- Do not ship a screenshot of the whole page as the implementation.
- Do not use screenshot-backed text or controls that must remain selectable,
  accessible, interactive, localized, or responsive.
- Do not stretch an extracted bitmap beyond the resolution supported by the
  reference. Obtain a source asset or rebuild a vector when it must scale.
- Always compare against the original reference, never only against an earlier
  version of your own render.
