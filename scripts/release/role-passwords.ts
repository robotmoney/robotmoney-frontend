#!/usr/bin/env bun
// `bun run role-passwords --target <stage|prod>` — the control machine's way to
// run `prod-init role-passwords` on a target host (decision D61, owner
// 2026-10-08). A provisioning precondition run before `release:run`, never a
// release step.
//
//   bun run role-passwords --target <stage|prod|path> [--doadmin-stdin] [--roles <role,…>] [--rotate <role,…>]
//
// THE DOADMIN RULE. doadmin is never stored in any file, on either machine.
// This wrapper asks the admin for it with a hidden prompt (or reads one line
// from its own stdin with `--doadmin-stdin`, so an agent or the stage rehearsal
// can pipe it), then runs on the target host
//
//   ssh -T -o BatchMode=yes <host> 'cd <checkout> && env -i HOME=<home> PATH=<path> LANG=C.UTF-8 RM_ENV=<env> \
//     bun scripts/prod-init.ts role-passwords --instance <i> --confirm-target <T> --doadmin-stdin [...]'
//
// and writes the password, with one newline, to that ssh process's stdin and
// nothing else. The value never appears in an argument, a file or any output
// on either machine: the remote command line holds only the target's names,
// the same `env -i` environment every release step runs with
// (scripts/release/steps.ts BASE_ENV), and the flags.
//
// The target comes from the same files `release:run` reads
// (scripts/release/targets/<name>.json), so the host, checkout, home,
// instance and `--confirm-target` are the ones the release itself will use.
import { DOADMIN_STDIN_FLAG, readDoadminPassword, type SecretInput, type SecretOutput } from "../lib/doadmin-input.ts";
import { targetPath } from "./run.ts";
import { BASE_ENV, shellQuote } from "./steps.ts";
import { loadTarget, type ReleaseTarget } from "./target.ts";

const USAGE = "usage: bun run role-passwords --target <stage|prod|path> [--doadmin-stdin] [--roles <role,…>] [--rotate <role,…>]";

/** Role lists are names only: checked here so nothing odd reaches a remote shell. */
const ROLE_LIST = /^(rm_owner|rm_app|rm_worker|rm_readonly)(,(rm_owner|rm_app|rm_worker|rm_readonly))*$/;

export interface WrapperArgs {
  readonly target: string;
  readonly doadminStdin: boolean;
  readonly roles?: string;
  readonly rotate?: string;
}

export function parseWrapperArgs(argv: readonly string[]): WrapperArgs | { error: string } {
  let target: string | undefined;
  let roles: string | undefined;
  let rotate: string | undefined;
  let doadminStdin = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === DOADMIN_STDIN_FLAG) doadminStdin = true;
    else if (a === "--target" || a === "--roles" || a === "--rotate") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { error: `${a} takes a value. ${USAGE}` };
      if (a === "--target") target = v;
      else if (a === "--roles") roles = v;
      else rotate = v;
    } else return { error: `unknown argument ${JSON.stringify(a.startsWith("--") ? a : "(a value)")}. ${USAGE}` };
  }
  if (!target) return { error: `--target is required. ${USAGE}` };
  for (const [name, v] of [["--roles", roles], ["--rotate", rotate]] as const) {
    if (v !== undefined && !ROLE_LIST.test(v)) return { error: `${name} takes a comma-separated list of rm_owner, rm_app, rm_worker, rm_readonly.` };
  }
  return { target, doadminStdin, roles, rotate };
}

/** The remote shell command: names and flags only, never a secret. */
export function remoteCommand(target: ReleaseTarget, args: WrapperArgs): string {
  const env = [`HOME=${shellQuote(target.home)}`, ...Object.entries(BASE_ENV).map(([k, v]) => `${k}=${shellQuote(v)}`), `RM_ENV=${shellQuote(target.rmEnv)}`];
  const argv = [
    "bun", "scripts/prod-init.ts", "role-passwords",
    "--instance", target.instance,
    "--confirm-target", target.confirmTarget,
    DOADMIN_STDIN_FLAG,
    ...(args.roles ? ["--roles", args.roles] : []),
    ...(args.rotate ? ["--rotate", args.rotate] : []),
  ];
  return `cd ${shellQuote(target.legacy.checkout)} && env -i ${env.join(" ")} ${argv.map(shellQuote).join(" ")}`;
}

/** The ssh argv: the host and the remote command. */
export function sshArgv(target: ReleaseTarget, args: WrapperArgs): string[] {
  return ["ssh", "-T", "-o", "BatchMode=yes", target.host, remoteCommand(target, args)];
}

export interface WrapperDeps {
  loadTarget(arg: string): ReleaseTarget;
  readonly stdin: SecretInput;
  readonly stderr: SecretOutput;
  /** Run argv with `input` as its whole stdin, output passed through; resolve to the exit code. */
  run(argv: readonly string[], input: string): Promise<number>;
  log(line: string): void;
}

export async function runWrapper(argv: readonly string[], deps: WrapperDeps): Promise<number> {
  const args = parseWrapperArgs(argv);
  if ("error" in args) {
    deps.log(`role-passwords: ${args.error}`);
    return 2;
  }
  let target: ReleaseTarget;
  try {
    target = deps.loadTarget(args.target);
  } catch (error) {
    deps.log(`role-passwords: ${(error as Error).message}`);
    return 2;
  }
  deps.log(`role-passwords: ${target.name} (${target.rmEnv}) on ${target.host}, --confirm-target ${target.confirmTarget}`);
  let password: string;
  try {
    password = await readDoadminPassword(args.doadminStdin ? [DOADMIN_STDIN_FLAG] : [], deps.stdin, deps.stderr);
  } catch (error) {
    deps.log(`role-passwords: ${(error as Error).message}`);
    return 2;
  }
  return deps.run(sshArgv(target, args), `${password}\n`);
}

if (import.meta.main) {
  const code = await runWrapper(process.argv.slice(2), {
    loadTarget: (arg) => loadTarget(targetPath(arg)),
    stdin: process.stdin,
    stderr: process.stderr,
    async run(argv, input) {
      const child = Bun.spawn([...argv], { stdin: "pipe", stdout: "inherit", stderr: "inherit" });
      child.stdin.write(input);
      await child.stdin.end();
      return await child.exited;
    },
    log: (line) => console.error(line),
  });
  process.exit(code);
}
