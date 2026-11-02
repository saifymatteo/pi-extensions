# Operating a GUI from screenshots

**When to use**: the task is to act on a live screen — click, type,
scroll — guided by screenshots: driving an app, automating a workflow,
walking a bug reproduction. The vision layer answers "where is it" and
"what state is it in"; the acting itself goes through whatever automation
channel the task already has.

Tool syntax lives in `SKILL.md`. This file is the sequence and the
pass/fail test.

## Steps

**1. Calibrate coordinates once, before the first click.**

Screenshot pixels and pointer coordinates are often different spaces: on
HiDPI displays a screenshot is 2-3× the logical points the click API
takes. Compare the screenshot's pixel width to the screen's logical width
and divide every box by that ratio. Skipping this puts every click at half
or double distance from the origin — consistently wrong in a way that
looks like bad grounding.

**2. Prefer the UI tree; fall back to vision.**

If the environment exposes a UI tree (Android `uiautomator dump`, desktop
accessibility tree, browser DOM), read coordinates and state from there —
it is exact, fast, and carries semantic attributes (enabled, checked,
focusable) that pixels cannot. Fall back to native screenshot inspection when:

- No tree is available (games, custom-rendered canvases, remote desktops),
- The target element is absent from the tree (canvas-drawn overlays,
  non-standard widgets), or
- You need to verify a visual state the tree doesn't expose (color, icon
  appearance).

Inspect the screenshot natively with the main agent's image reader. If a
small target or state is unclear, crop the region and read it natively;
translate crop coordinates back to the full screenshot before calibration.
Use `ground` for an unresolved target box, `detect` for an inventory, or
`glance` for a second opinion/OCR when needed.

Model boxes are estimates: they can point at the wrong target or omit much
of it, not just miss an edge by a few pixels. Verify the target visually
before clicking its center. For tiny targets (checkboxes, close buttons),
inspect a larger crop before acting.

For elements that stay put across interactions (toolbar buttons, sidebar
links, fixed panels), record verified center coordinates in a table with
an id/label. Reuse them only while fresh screenshots confirm the layout is
unchanged. Invalidate the table on resize, navigation, or scroll.

**3. One screenshot per action — act, re-shoot, verify, then continue.**

Every action invalidates the current screenshot: menus open, focus moves,
content loads; scrolling invalidates every box at once. Chaining several
clicks on one stale screenshot is how you click through where a dialog
used to be.

**4. Verify as a question about the expected state.**

Read the fresh screenshot natively to answer the expected-state question,
for example "is the settings dialog open?" If not, stop and inspect the
current screen instead of pressing on against an assumed state. For a
small change (a toggle, one badge), optionally use `pixel_diff` to locate
the changed region, then crop and read it natively. A targeted `glance`
question remains available for an unresolved state.

**5. After typing, read the field back.**

Focus loss eats keystrokes silently. Read the field value from the UI tree
when available; otherwise inspect it natively, cropping if necessary.
Use targeted OCR only if the text remains unclear. Confirm the text
actually landed before submitting.

## Verify

The loop in steps 3-4 *is* the verification: no action counts as done
until a fresh screenshot answers the expected-state question. For a
multi-step flow, the final screenshot must show the end state the task
defines — the confirmation page, the saved indicator. A completed action
list is not evidence; the pixels are.

## Boundaries

- Loading is asynchronous: after an action that triggers it, poll —
  re-screenshot until two consecutive shots stop differing (`pixel_diff`
  near 0) — rather than trusting one fixed sleep.
- Irreversible actions (send, delete, pay) follow the calling agent's own
  confirmation policy. The vision layer reports what is on screen; it
  never makes that call.
- A screen the task didn't predict — an error dialog, a permission
  prompt, a login wall — is a stop-and-surface, not an obstacle to click
  through. Clicking through unknown dialogs is how automations do damage.
