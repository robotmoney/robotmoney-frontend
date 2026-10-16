// scripts/release/scrub.ts — defensive secret scrubbing for everything the
// release runner prints or journals (D61: the credentials "never appear in a
// receipt, a journal, a process argument or command output").
//
// The host commands already print no secret. This is the second wall: the
// runner never knows a secret's value, so it scrubs by SHAPE — a known secret
// key followed by a value, a password inside a postgres URL, a bearer token.
// Over-scrubbing a harmless line is acceptable; leaking one value is not.

/** Keys whose value is a secret wherever they appear as `KEY=value` or `"KEY": "value"`. */
export const SECRET_KEYS: readonly string[] = Object.freeze([
  "rm_owner",
  "doadmin",
  "rm_app",
  "rm_worker",
  "rm_readonly",
  "COINGECKO_API_KEY",
  "OPENCODE_API_KEY",
  "ADMIN_TOKEN",
  "PGPASSWORD",
  "POSTGRES_PASSWORD",
  "password",
  "passphrase",
  "secret",
  "token",
  "bearer",
  "apiKey",
  "api_key",
  "privateKey",
  "private_key",
]);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const KEY_ALT = SECRET_KEYS.map(escape).join("|");

// `KEY = value`, `KEY: value`, `"KEY": "value"`, `export KEY=value`. The key is a
// whole word, so `tokenValid=false` and `rm_readonly@host` are left alone. A key
// right after `/` is a URL's user name, which URL_PASSWORD handles.
const KEY_VALUE = new RegExp(
  `(^|[^A-Za-z0-9_/])(["']?)(${KEY_ALT})\\2(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;}]+)`,
  "gi",
);
const URL_PASSWORD = /\b(postgres(?:ql)?:\/\/[^:\/\s@]+):[^@\s]+@/gi;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+\/=-]+/gi;
const AUTH_HEADER = /\b(Authorization)\s*:\s*\S.*$/gim;

// An unquoted value that runs into the closing quote of the string around it,
// as `"/s/tokens/x:/run/rm-token:ro"` in a docker inspect bind does. The quote
// and any brackets after it are kept, or the scrubbed receipt is no longer
// JSON (stage practice run 2026-10-14). A quote inside the value is not this
// shape, and the whole value is still scrubbed.
const CLOSING_QUOTE = /["'][\])]*$/;

/** Scrub one block of text. Idempotent. */
export function scrubSecrets(text: string): string {
  return text
    .replace(URL_PASSWORD, "$1:***@")
    .replace(BEARER, "$1 ***")
    .replace(AUTH_HEADER, "$1: ***")
    .replace(KEY_VALUE, (_m, pre: string, q: string, key: string, sep: string, value: string) => {
      const head = `${pre}${q}${key}${q}${sep}`;
      if (value === "***" || value === '"***"') return head + value;
      if (value.startsWith('"') || value.startsWith("'")) return head + (value.startsWith('"') ? '"***"' : "***");
      const close = CLOSING_QUOTE.exec(value)?.[0] ?? "";
      return value.length > close.length ? `${head}***${close}` : head + value;
    });
}

/**
 * A line splitter for a stream: scrubbing works on whole lines, so a secret
 * split across two chunks is still caught. `push` returns the complete lines
 * scrubbed; `end` flushes the tail.
 */
export function lineScrubber(): { push(chunk: string): string; end(): string } {
  let tail = "";
  return {
    push(chunk: string): string {
      const text = tail + chunk;
      const cut = text.lastIndexOf("\n");
      if (cut < 0) {
        tail = text;
        return "";
      }
      tail = text.slice(cut + 1);
      return scrubSecrets(text.slice(0, cut + 1));
    },
    end(): string {
      const out = scrubSecrets(tail);
      tail = "";
      return out;
    },
  };
}

/** Paths the runner never copies back, whatever a step's output names. */
export function forbiddenReceiptPath(path: string): boolean {
  return /(^|\/)tokens(\/|$)|role-passwords|(^|\/)\.env|credential|passphrase|\.gpg$|\.dump$|\.pgpass/i.test(path);
}
