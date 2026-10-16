// scripts/lib/doadmin-input.ts — the doadmin password, typed or piped, held in
// process memory only (decision D61, owner 2026-10-08).
//
// THE RULE. doadmin is NEVER stored in any file. The admin types it into the
// password-setting tool each run (`prod-init role-passwords`, or the control
// machine's `bun run role-passwords`), and it lives only in that process's
// memory. So this module reads it from exactly two places:
//   - a hidden prompt, when stdin is a terminal (nothing is echoed);
//   - stdin, when `--doadmin-stdin` is passed: one line, then EOF. This is how
//     the control-machine wrapper hands it over ssh, and how an agent or a test
//     is given it through a pipe.
// Never a file, an environment variable, argv or `~/.env`: nothing here can
// read one, and a caller that passes neither a terminal nor the flag is
// refused.
//
// WHAT IT NEVER DOES. It never prints, logs or returns the value inside a
// message. A refusal names the source, never the value.

/** The flag that takes the password from stdin instead of a prompt. */
export const DOADMIN_STDIN_FLAG = "--doadmin-stdin";

/** A refusal over the doadmin input. The message never holds a secret. */
export class DoadminInputRefused extends Error {}

/** The slice of a readable stream this module needs; a fake TTY implements it in tests. */
export interface SecretInput {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeAllListeners(event?: string): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface SecretOutput {
  write(text: string): unknown;
}

/** Everything up to EOF; the first line is the value. More than one non-empty line refuses. */
export function readSecretFromStdin(input: SecretInput): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    input.on("data", (chunk) => chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    input.on("error", (error) => reject(new DoadminInputRefused(`reading the doadmin password from stdin failed (${error.message.slice(0, 80)}).`)));
    input.on("end", () => {
      input.removeAllListeners();
      const lines = chunks.join("").split(/\r?\n/).filter((l) => l !== "");
      if (lines.length !== 1) {
        reject(new DoadminInputRefused(`${DOADMIN_STDIN_FLAG} reads one line, then EOF; stdin held ${lines.length} non-empty lines.`));
        return;
      }
      resolve(lines[0]!);
    });
    input.resume();
  });
}

/** A hidden prompt on a terminal: raw mode, no echo, Enter ends, Ctrl-C refuses. */
export function promptHidden(prompt: string, input: SecretInput, output: SecretOutput): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      reject(new DoadminInputRefused("stdin is not a terminal, so there is nothing to prompt on."));
      return;
    }
    output.write(prompt);
    input.setRawMode(true);
    let value = "";
    const finish = (error?: Error): void => {
      input.setRawMode?.(false);
      input.removeAllListeners("data");
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    input.on("data", (chunk) => {
      for (const ch of typeof chunk === "string" ? chunk : chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish(value === "" ? new DoadminInputRefused("no doadmin password was typed.") : undefined);
        if (ch === "\u0003" || ch === "\u0004") return finish(new DoadminInputRefused("the doadmin prompt was cancelled."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    });
    input.resume();
  });
}

/**
 * The doadmin password for one run: from stdin with `--doadmin-stdin`, else a
 * hidden prompt on a terminal, else a refusal.
 */
export async function readDoadminPassword(argv: readonly string[], input: SecretInput, output: SecretOutput): Promise<string> {
  if (argv.includes(DOADMIN_STDIN_FLAG)) return readSecretFromStdin(input);
  if (input.isTTY) return promptHidden("doadmin password (not echoed, not stored): ", input, output);
  throw new DoadminInputRefused(
    `no terminal to prompt on and no ${DOADMIN_STDIN_FLAG}. The doadmin password is typed each run, or piped on stdin ` +
      `with ${DOADMIN_STDIN_FLAG}; it is never read from a file, an environment variable, argv or ~/.env (D61).`,
  );
}
