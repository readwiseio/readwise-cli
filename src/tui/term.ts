// Low-level terminal utilities for flicker-free full-screen rendering.
// Instead of clearing and rewriting (which blinks), we position the cursor
// at home and overwrite in-place — content is never erased before being replaced.

const ESC = "\x1b";

// --- ANSI helpers ---

export const style = {
  bold: (s: string) => `${ESC}[1m${s}${ESC}[22m`,
  dim: (s: string) => `${ESC}[2m${s}${ESC}[22m`,
  inverse: (s: string) => `${ESC}[7m${s}${ESC}[27m`,
  yellow: (s: string) => `${ESC}[33m${s}${ESC}[39m`,
  red: (s: string) => `${ESC}[31m${s}${ESC}[39m`,
  green: (s: string) => `${ESC}[32m${s}${ESC}[39m`,
  cyan: (s: string) => `${ESC}[36m${s}${ESC}[39m`,
  boldYellow: (s: string) => `${ESC}[1;33m${s}${ESC}[22;39m`,
  blue: (s: string) => `${ESC}[38;2;60;110;253m${s}${ESC}[39m`,
};

// --- Screen control ---

export function enterFullScreen(): void {
  process.stdout.write(`${ESC}[?1049h`); // alternate screen buffer
  process.stdout.write(`${ESC}[?2004h`); // enable bracketed paste mode
  process.stdout.write(`${ESC}[>1u`);    // enable kitty keyboard protocol (disambiguate mode)
  process.stdout.write(`${ESC}[?25l`);   // hide cursor
  process.stdout.write(`${ESC}[H`);      // cursor home
}

export function exitFullScreen(): void {
  process.stdout.write(`${ESC}[?25h`);   // show cursor
  process.stdout.write(`${ESC}[<u`);     // disable kitty keyboard protocol
  process.stdout.write(`${ESC}[?2004l`); // disable bracketed paste mode
  process.stdout.write(`${ESC}[?1049l`); // restore screen buffer
}

/** Paint lines to terminal without flicker: cursor home → overwrite each line → clear remainder */
export function paint(lines: string[]): void {
  const rows = process.stdout.rows ?? 24;
  let out = `${ESC}[H`; // cursor home
  const count = Math.min(lines.length, rows);
  for (let i = 0; i < count; i++) {
    out += lines[i] + `${ESC}[K`; // line content + clear to end of line
    if (i < count - 1) out += "\n";
  }
  // Clear any remaining lines below content
  if (count < rows) {
    out += `\n${ESC}[J`; // clear from cursor to end of screen
  }
  process.stdout.write(out);
}

export function screenSize(): { cols: number; rows: number } {
  return { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
}

// --- Keyboard input ---

export interface KeyEvent {
  raw: string;
  name: string; // 'up', 'down', 'return', 'escape', 'tab', 'backspace', 'pageup', 'pagedown', or the character
  shift: boolean;
  ctrl: boolean;
}

export function parseKey(data: Buffer): KeyEvent {
  const s = data.toString("utf-8");

  // Bracketed paste: \x1b[200~ ... \x1b[201~
  if (s.startsWith(`${ESC}[200~`)) {
    const content = s.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return { raw: normalized, name: "paste", shift: false, ctrl: false };
  }

  // Alt+Enter (ESC + CR/LF) — reliable newline insertion across all terminals
  if (s === `${ESC}\r` || s === `${ESC}\n`) {
    return { raw: s, name: "return", shift: true, ctrl: false };
  }

  // Alt+Arrow (word navigation)
  if (s === `${ESC}[1;3D` || s === `${ESC}b`) return { raw: s, name: "wordLeft", shift: false, ctrl: false };
  if (s === `${ESC}[1;3C` || s === `${ESC}f`) return { raw: s, name: "wordRight", shift: false, ctrl: false };
  // Alt+Backspace (word delete)
  if (s === `${ESC}\x7f`) return { raw: s, name: "wordBackspace", shift: false, ctrl: false };

  const ctrl = s.length === 1 && s.charCodeAt(0) < 32;

  // Escape sequences
  if (s === `${ESC}[A`) return { raw: s, name: "up", shift: false, ctrl: false };
  if (s === `${ESC}[B`) return { raw: s, name: "down", shift: false, ctrl: false };
  if (s === `${ESC}[C`) return { raw: s, name: "right", shift: false, ctrl: false };
  if (s === `${ESC}[D`) return { raw: s, name: "left", shift: false, ctrl: false };
  if (s === `${ESC}[5~`) return { raw: s, name: "pageup", shift: false, ctrl: false };
  if (s === `${ESC}[6~`) return { raw: s, name: "pagedown", shift: false, ctrl: false };
  if (s === `${ESC}[Z`) return { raw: s, name: "tab", shift: true, ctrl: false };
  if (s === ESC || s === `${ESC}${ESC}`) return { raw: s, name: "escape", shift: false, ctrl: false };

  // Kitty keyboard protocol CSI-u encodings (when disambiguate mode is active)
  if (s === `${ESC}[13;2u`) return { raw: s, name: "return", shift: true, ctrl: false };  // Shift+Enter
  if (s === `${ESC}[27;2;13~`) return { raw: s, name: "return", shift: true, ctrl: false }; // Shift+Enter (xterm)
  if (s === `${ESC}OM`) return { raw: s, name: "return", shift: true, ctrl: false };         // Shift+Enter (misc)
  if (s === `${ESC}[27u`) return { raw: s, name: "escape", shift: false, ctrl: false };
  if (s === `${ESC}[13u`) return { raw: s, name: "return", shift: false, ctrl: false };
  if (s === `${ESC}[9u`) return { raw: s, name: "tab", shift: false, ctrl: false };
  if (s === `${ESC}[9;2u`) return { raw: s, name: "tab", shift: true, ctrl: false };
  if (s === `${ESC}[127u`) return { raw: s, name: "backspace", shift: false, ctrl: false };

  // Single characters
  if (s === "\r" || s === "\n") return { raw: s, name: "return", shift: false, ctrl: false };
  if (s === "\t") return { raw: s, name: "tab", shift: false, ctrl: false };
  if (s === "\x7f" || s === "\b") return { raw: s, name: "backspace", shift: false, ctrl: false };
  if (s === "\x03") return { raw: s, name: "c", shift: false, ctrl: true }; // Ctrl+C
  if (s === "\x04") return { raw: s, name: "d", shift: false, ctrl: true }; // Ctrl+D

  if (ctrl) {
    return { raw: s, name: String.fromCharCode(s.charCodeAt(0) + 96), shift: false, ctrl: true };
  }

  // Multi-character non-escape input = paste (terminal without bracketed paste support)
  if (s.length > 1 && !s.startsWith(ESC)) {
    const normalized = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return { raw: normalized, name: "paste", shift: false, ctrl: false };
  }

  return { raw: s, name: s, shift: false, ctrl: false };
}

/** Strip ANSI escape codes to get visible character count */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Skip `offset` visible characters, preserving ANSI state, then return the rest */
export function ansiSlice(s: string, offset: number): string {
  if (offset <= 0) return s;
  // Collect ANSI sequences encountered while skipping so we can replay them
  let activeAnsi = "";
  let count = 0;
  let i = 0;
  while (i < s.length && count < offset) {
    if (s[i] === "\x1b") {
      const end = s.indexOf("m", i);
      if (end >= 0) {
        activeAnsi += s.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    count++;
    i++;
  }
  // Consume any ANSI codes right at the boundary
  while (i < s.length && s[i] === "\x1b") {
    const end = s.indexOf("m", i);
    if (end >= 0) {
      activeAnsi += s.slice(i, end + 1);
      i = end + 1;
    } else break;
  }
  return activeAnsi + s.slice(i);
}

/** Pad/truncate a string to a visible width (ANSI-aware) */
export function fitWidth(s: string, width: number): string {
  const visible = stripAnsi(s);
  if (visible.length >= width) {
    // Truncate — need to be careful with ANSI codes
    let count = 0;
    let i = 0;
    while (i < s.length && count < width) {
      if (s[i] === "\x1b") {
        const end = s.indexOf("m", i);
        if (end >= 0) { i = end + 1; continue; }
      }
      count++;
      i++;
    }
    // Include any trailing ANSI reset codes
    const rest = s.slice(i);
    const resets = rest.match(/^(\x1b\[[0-9;]*m)*/)?.[0] || "";
    return s.slice(0, i) + resets;
  }
  return s + " ".repeat(width - visible.length);
}
