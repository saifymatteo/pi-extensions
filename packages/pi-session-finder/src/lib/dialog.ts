// One size for every overlay dialog in this package. Change DIALOG_HEIGHT here and every dialog follows:
// the overlay is capped at that share of the terminal and each dialog pads its list to fill it.

/** Share of the terminal height every dialog fills. */
export const DIALOG_HEIGHT = 0.8

/** `ctx.ui.custom(factory, DIALOG_OVERLAY)`: centered, 92% wide, DIALOG_HEIGHT tall. */
export const DIALOG_OVERLAY = {
  overlay: true,
  overlayOptions: { anchor: 'center', width: '92%', maxHeight: `${DIALOG_HEIGHT * 100}%`, margin: 1 },
} as const

/**
 * Scrolling rows that fit once `chrome` fixed lines (borders, search, header, footer) are drawn.
 * Same floor as the overlay's own percentage, so dialog and overlay agree; read it in render() so a
 * resize takes effect on the next frame.
 */
export const dialogRows = (tui: { terminal?: { rows: number } }, chrome: number, min = 1): number =>
  Math.max(min, Math.floor((tui.terminal?.rows ?? 24) * DIALOG_HEIGHT) - chrome)

/**
 * Mouse wheel → ↑/↓ key presses, so a dialog reuses its own keyboard handling (clamping, render).
 * Use as `handleMouse(e) { return wheelAsArrows(e, (k) => this.handleInput(k)) }`. Fullscreen mode only:
 * regular mode leaves the mouse to the terminal. Handling the wheel also stops it scrolling the transcript behind.
 */
export function wheelAsArrows(event: { type: string; wheelDelta?: number }, handleInput: (data: string) => void): { handled: true } | undefined {
  if (event.type !== 'wheel' || !event.wheelDelta) return undefined
  const key = event.wheelDelta < 0 ? '\x1b[A' : '\x1b[B'
  for (let i = 0; i < Math.min(Math.abs(event.wheelDelta), 20); i++) handleInput(key)
  return { handled: true }
}
