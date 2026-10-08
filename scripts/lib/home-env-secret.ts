// scripts/lib/home-env-secret.ts — write one secret line into `$HOME/.env`,
// atomically (decision D61; `prod-init role-passwords`'s generate path).
//
// `prod-init role-passwords` generates a role's password on the host when
// `~/.env` has no line for it (or on `--rotate <role>`), sets it through
// doadmin, and then keeps it here, the one credential file D61 names.
//
// WHAT IT GUARANTEES.
//   - Every other line of the file is kept, byte for byte and in order:
//     comments, blank lines, spacing and `export` prefixes included.
//   - The `key = value` line replaces the first line whose key is `key` (the
//     same key rule as env-role.ts parseEnvFile). Any later duplicate of that
//     key is dropped, so the parsed file holds the new value and nothing else.
//     With no such line, it is appended at the end.
//   - The write is atomic: a temp file in the same directory, mode 0600,
//     flushed to disk, then renamed over the file. A reader sees the old file
//     or the new one, never half of either. The result is mode 0600.
//   - On a rotation the old line is kept in `<file>.retired-<timestamp>`, mode
//     0600, written before the file is replaced.
//
// WHAT IT NEVER DOES. It never prints, logs or returns a value, and an error it
// throws names the file and the key only.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";

/** The key of one `.env` line, by env-role.ts parseEnvFile's rule; undefined for a comment, blank or key-less line. */
export function envLineKey(rawLine: string): string | undefined {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) return undefined;
  const eq = line.indexOf("=");
  if (eq < 0) return undefined;
  const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
  return key || undefined;
}

/** A value safe to write unquoted: no whitespace, quote, `#` or newline. */
const SAFE_VALUE = /^[A-Za-z0-9_\-.~+/=:@%]+$/;

/** The file text with `key = value` in place of the first `key` line (later duplicates dropped), or appended. */
export function withEnvLine(text: string, key: string, value: string): { text: string; previousLine: string | undefined } {
  if (!SAFE_VALUE.test(value)) throw new Error(`refusing to write the ${key} line: the value has a character a .env line cannot hold unquoted.`);
  const newline = `${key} = ${value}`;
  const lines = text.split("\n");
  // A trailing newline leaves one empty last element: keep it as the ending.
  const endsWithNewline = text.endsWith("\n");
  if (endsWithNewline) lines.pop();
  let previousLine: string | undefined;
  const out: string[] = [];
  for (const line of lines) {
    if (envLineKey(line) === key) {
      if (previousLine === undefined) {
        previousLine = line;
        out.push(newline);
      }
      continue;
    }
    out.push(line);
  }
  if (previousLine === undefined) out.push(newline);
  return { text: `${out.join("\n")}\n`, previousLine };
}

function writeAtomic(path: string, text: string): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export interface WriteEnvSecretResult {
  /** True when a `key` line was there before and is now replaced. */
  readonly replaced: boolean;
  /** The file the old line was kept in, on a rotation that replaced one. */
  readonly retiredFile?: string;
}

/**
 * Put `key = value` into the `.env` file at `path`, atomically, keeping every
 * other line. With `retire`, an existing `key` line is first kept in
 * `<path>.retired-<timestamp>` (mode 0600). Without `retire`, an existing
 * `key` line refuses: replacing a password is a rotation, never a side effect.
 */
export function writeEnvSecret(
  path: string,
  key: string,
  value: string,
  options: { readonly retire?: boolean; readonly now?: Date } = {},
): WriteEnvSecretResult {
  const before = readFileSync(path, "utf8");
  const { text, previousLine } = withEnvLine(before, key, value);
  let retiredFile: string | undefined;
  if (previousLine !== undefined) {
    if (!options.retire) {
      throw new Error(`refusing to replace the ${key} line of ${path} without a rotation. Nothing was written.`);
    }
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    retiredFile = `${path}.retired-${stamp}`;
    const header = `# The ${key} line ${path} held until ${stamp}, retired by prod-init role-passwords --rotate (D61).\n`;
    writeAtomic(retiredFile, `${header}${previousLine.trim()}\n`);
  }
  writeAtomic(path, text);
  return { replaced: previousLine !== undefined, ...(retiredFile === undefined ? {} : { retiredFile }) };
}
