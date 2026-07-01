// Zero-dependency ANSI terminal-UI renderer for the standing demo. No ink/blessed,
// no new npm deps — the repo is buildless/minimal-dep. It owns the alternate
// screen, the repaint timer, and a few text helpers; the caller owns all state
// and supplies a pure `render(): string[]` that returns the lines to paint.
//
// Design notes:
//  - We NEVER clear the whole screen each frame (that flickers). Instead we move
//    to home, overwrite each visible line and clear to EOL (\x1b[K), then clear
//    everything below the last written line (\x1b[J). This is diff-free but
//    flicker-free because the cursor never blanks the region it is about to fill.
//  - Terminal restore is registered on process 'exit' as a one-shot, so an
//    uncaught throw / process.exit still leaves the user with a visible cursor
//    and the normal screen — never leftover escape junk.

// --- ANSI escape sequences ------------------------------------------------
const ESC = "\x1b[";
const ALT_ON = `${ESC}?1049h`; // enter alternate screen buffer
const ALT_OFF = `${ESC}?1049l`; // leave alternate screen buffer
const CURSOR_HIDE = `${ESC}?25l`;
const CURSOR_SHOW = `${ESC}?25h`;
const HOME = `${ESC}H`; // cursor to row 1, col 1
const CLEAR_EOL = `${ESC}K`; // clear from cursor to end of line
const CLEAR_BELOW = `${ESC}J`; // clear from cursor to end of screen

// --- Text helpers (exported for the caller's render fn) -------------------

// Wrap `text` in an SGR color code, reset after. `code` is an SGR parameter
// string, e.g. "32" (green), "1;36" (bold cyan), or "38;5;208" (256-color).
export function color(code: string, text: string): string {
  return `${ESC}${code}m${text}${ESC}0m`;
}

// Visible-length-aware truncate: measures/cuts on the printable text with any
// SGR sequences stripped for the width math, but keeps the (short) codes. Since
// our color() spans never cross a truncate boundary in practice, we take the
// simple, correct-for-our-use path: strip codes to measure, and if it fits,
// return as-is; otherwise truncate the *stripped* text (dropping colors on the
// overflowing line, which is fine — overflow is rare and cosmetic).
const STRIP_ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export function visibleLen(text: string): number {
  return text.replace(STRIP_ANSI, "").length;
}
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLen(text) <= width) return text;
  const plain = text.replace(STRIP_ANSI, "");
  if (plain.length <= width) return text; // colored but fits
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

// A horizontal rule, optionally with an inline title: "── title ──────────".
export function hr(width: number, title?: string): string {
  if (width <= 0) return "";
  if (!title) return "─".repeat(width);
  const label = ` ${title} `;
  if (label.length >= width) return truncate(label, width);
  return "──" + label + "─".repeat(Math.max(0, width - label.length - 2));
}

// Spinner frame from a monotonic tick counter (NOT Date.now/random — keeps it
// deterministic and test-friendly; runtime callers just pass an incrementing n).
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function spinner(tick: number): string {
  return SPINNER[((tick % SPINNER.length) + SPINNER.length) % SPINNER.length];
}

// --- The renderer ---------------------------------------------------------

export interface TuiOptions {
  render: () => string[]; // caller-supplied; returns the lines to paint
  intervalMs?: number; // repaint cadence (default ~250ms)
  out?: NodeJS.WriteStream; // defaults to process.stdout
}

export interface Tui {
  start(): void;
  stop(): void;
  repaint(): void; // force an immediate frame
  get columns(): number;
  get rows(): number;
}

export function createTui(opts: TuiOptions): Tui {
  const out = opts.out ?? process.stdout;
  const intervalMs = opts.intervalMs ?? 250;
  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let restored = false;

  const cols = () => out.columns || 80;
  const rows = () => out.rows || 24;

  // Paint one frame: home, then each visible line padded/truncated to width with
  // clear-to-EOL, then clear everything below. No full clear → no flicker.
  function paint(): void {
    if (!started) return;
    const width = cols();
    const height = rows();
    const lines = opts.render();
    const visible = lines.slice(0, height);
    let buf = HOME;
    for (const line of visible) {
      buf += truncate(line, width) + CLEAR_EOL + "\n";
    }
    // Cursor is now just below the last written line; wipe any stale rows below.
    buf += CLEAR_BELOW;
    out.write(buf);
  }

  // Restore the terminal to its normal state. Idempotent + one-shot safe so it
  // can run from stop(), signal handlers, AND the 'exit' hook without double-work.
  function restore(): void {
    if (restored) return;
    restored = true;
    if (timer) { clearInterval(timer); timer = null; }
    out.write(CURSOR_SHOW + ALT_OFF);
    process.off("resize", onResize);
    out.off?.("resize", onResize);
  }

  function onResize(): void { paint(); }

  function start(): void {
    if (started) return;
    started = true;
    restored = false;
    out.write(ALT_ON + CURSOR_HIDE + HOME + CLEAR_BELOW);
    // Re-read size + repaint on terminal resize (SIGWINCH surfaces as 'resize').
    out.on?.("resize", onResize);
    timer = setInterval(paint, intervalMs);
    // ALWAYS restore on exit, even on throw/process.exit — one-shot guarded.
    process.once("exit", restore);
    paint();
  }

  function stop(): void {
    if (!started) return;
    started = false;
    restore();
  }

  return {
    start,
    stop,
    repaint: paint,
    get columns() { return cols(); },
    get rows() { return rows(); },
  };
}
