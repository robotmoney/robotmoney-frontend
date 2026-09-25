// The masked terminal prompt for the `rm_owner` password — the one credential
// §3 types rather than stores: "**`rm_owner` is `LOGIN`.** Its password is typed
// at the terminal for the one run that needs it and never stored."
//
// Its callers are backend/scripts/migrate-run.ts's promptOwnerPassword, which
// `bun run migrate` and a remote `bun smoke --migrate` both reach, and a remote
// `bun smoke --seed` (backend/scripts/smoke-prepare.ts). A local mode never
// prompts (§5: "No terminal prompt exists in local modes"): it uses the owner
// password smoke generated for the instance.
//
// WHAT THIS MODULE NO LONGER DOES. It used to prompt for `doadmin` on a remote
// `--migrate` and hand that login to a one-shot migrate container as
// MIGRATE_DATABASE_URL, to run the legacy runner. §3 makes `doadmin` cluster
// provisioning only, and the migration login is `rm_owner` (D47): that path is
// gone, with the legacy runner's container, the refuseIfSchemaBehind one-shot
// it guarded (preflight check 3 asks the same question of every path) and the
// shell hand-off of a migration credential. The smoke-side refusals a remote
// `--migrate` meets — prod, a non-rehearsal identity, a non-terminal, anything
// but an explicit `y` — are migrate-run.ts's, exercised at the smoke entry point
// by scripts/tests/unit/smoke-external-migrate.test.ts.

/**
 * Read one line from the terminal with the input masked. The one prompt a
 * migrate run or a remote `--seed` ever needs (the rm_owner password), so it
 * drives process.stdin directly rather than pulling in a readline.Interface.
 * Mirrors scripts/gitops-credentials.ts's `hidden()`.
 */
export async function hiddenPrompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `${question}: stdin is not a terminal. An operator must type the rm_owner password interactively — ` +
        "it is never read from an environment variable, a file, or a pipe (spec §3).",
    );
  }
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  // Raw mode BEFORE the question: a key typed the instant the question appears
  // would otherwise be echoed by the terminal's cooked mode.
  stdin.setRawMode?.(true);
  process.stdout.write(`${question}: `);
  stdin.resume();
  try {
    return await new Promise<string>((resolvePrompt) => {
      let input = "";
      const finish = (): void => {
        stdin.setRawMode?.(wasRaw);
        stdin.pause();
        stdin.off("data", onData);
        process.stdout.write("\n");
      };
      // One chunk is NOT one key. A pasted password arrives as a single
      // multi-character chunk, often ending in the Enter that submits it, so
      // every character is handled on its own.
      const onData = (data: Buffer) => {
        for (const char of data.toString()) {
          if (char === "\r" || char === "\n") {
            finish();
            resolvePrompt(input);
            return;
          }
          if (char === "\x03") {
            // Ctrl-C: restore the terminal before this process dies, or the
            // operator's shell is left with raw mode still on and echo off.
            finish();
            process.exit(130);
          }
          if (char === "\x7f" || char === "\b") {
            input = input.slice(0, -1);
          } else if (char >= " ") {
            input += char;
          }
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.pause();
  }
}
