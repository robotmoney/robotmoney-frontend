// scripts/release/role-passwords.ts: the control machine's `bun run
// role-passwords --target <stage|prod>` (D61, owner 2026-10-08). It reads the
// doadmin password locally (hidden prompt, or one line with --doadmin-stdin)
// and hands it to `prod-init role-passwords --doadmin-stdin` on the host over
// ssh's stdin, and nowhere else.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWrapperArgs, remoteCommand, runWrapper, sshArgv, type WrapperDeps } from "../../release/role-passwords.ts";
import { loadTarget } from "../../release/target.ts";
import type { SecretInput } from "../../lib/doadmin-input.ts";

const SECRET = "piped-doadmin-Zz9!secret";
const STAGE = loadTarget(join(import.meta.dir, "../../release/targets/stage.json"));

function pipe(text: string, tty = false): SecretInput {
  const ee = new EventEmitter();
  return {
    isTTY: tty,
    ...(tty ? { setRawMode: () => undefined } : {}),
    on: (e: string, l: (...a: any[]) => void) => ee.on(e, l),
    removeAllListeners: (e?: string) => (e ? ee.removeAllListeners(e) : ee.removeAllListeners()),
    resume: () => {
      queueMicrotask(() => {
        ee.emit("data", Buffer.from(text));
        if (!tty) ee.emit("end");
      });
    },
    pause: () => undefined,
  } as never;
}

function deps(stdin: SecretInput): { deps: WrapperDeps; runs: { argv: readonly string[]; input: string }[]; logs: string[]; stderr: string[] } {
  const runs: { argv: readonly string[]; input: string }[] = [];
  const logs: string[] = [];
  const stderr: string[] = [];
  return {
    runs, logs, stderr,
    deps: {
      loadTarget: () => STAGE,
      stdin,
      stderr: { write: (t: string) => stderr.push(t) },
      run: async (argv, input) => {
        runs.push({ argv, input });
        return 0;
      },
      log: (l) => logs.push(l),
    },
  };
}

describe("bun run role-passwords", () => {
  test("--doadmin-stdin: one ssh run whose stdin is exactly the password and a newline; the password is in no argument or output", async () => {
    const d = deps(pipe(`${SECRET}\n`));
    expect(await runWrapper(["--target", "stage", "--doadmin-stdin"], d.deps)).toBe(0);
    expect(d.runs.length).toBe(1);
    expect(d.runs[0]!.input).toBe(`${SECRET}\n`);
    expect(d.runs[0]!.argv.join(" ")).not.toContain(SECRET);
    for (const text of [...d.logs, ...d.stderr]) expect(text).not.toContain(SECRET);
  });

  test("the hidden prompt path, on a terminal: the typed value goes to stdin, nothing is echoed", async () => {
    const d = deps(pipe(`${SECRET}\r`, true));
    expect(await runWrapper(["--target", "stage"], d.deps)).toBe(0);
    expect(d.runs[0]!.input).toBe(`${SECRET}\n`);
    expect(d.stderr.join("")).toContain("doadmin password");
    expect(d.stderr.join("")).not.toContain(SECRET);
  });

  test("the remote command is the release's own env -i shape, with --doadmin-stdin and the target's names only", () => {
    const remote = remoteCommand(STAGE, { target: "stage", doadminStdin: true, roles: "rm_owner,rm_app", rotate: "rm_app" });
    expect(remote).toBe(
      `cd ${STAGE.legacy.checkout} && env -i HOME=${STAGE.home} ` +
        "PATH=/root/.bun/bin:/home/stage-server/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 RM_ENV=stage " +
        "bun scripts/prod-init.ts role-passwords --instance stage_target --confirm-target 172.17.0.1:25060/defaultdb --doadmin-stdin " +
        "--roles rm_owner,rm_app --rotate rm_app",
    );
    expect(sshArgv(STAGE, { target: "stage", doadminStdin: false }).slice(0, 5)).toEqual(["ssh", "-T", "-o", "BatchMode=yes", "rm-frontend-stage-2"]);
  });

  test("the real CLI, with a recording `ssh` on PATH: ssh's stdin is the password, its argv and every output are clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-role-passwords-ssh-"));
    try {
      writeFileSync(join(dir, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\ncat > "${dir}/stdin"\necho remote-ok\n`, { mode: 0o755 });
      const repo = join(import.meta.dir, "../../..");
      const child = Bun.spawn(["bun", "--no-env-file", "scripts/release/role-passwords.ts", "--target", "stage", "--doadmin-stdin"], {
        cwd: repo, stdin: "pipe", stdout: "pipe", stderr: "pipe",
        env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir },
      });
      child.stdin.write(`${SECRET}\n`);
      await child.stdin.end();
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, err: code === 0 ? "" : err }).toEqual({ code: 0, err: "" });
      expect(out).toContain("remote-ok");
      expect(readFileSync(join(dir, "stdin"), "utf8")).toBe(`${SECRET}\n`);
      const argv = readFileSync(join(dir, "argv"), "utf8");
      expect(argv).toContain("--doadmin-stdin");
      for (const text of [argv, out, err]) expect(text).not.toContain(SECRET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("RED CONTROL: no terminal and no --doadmin-stdin refuses without running ssh", async () => {
    const d = deps(pipe(`${SECRET}\n`));
    expect(await runWrapper(["--target", "stage"], d.deps)).toBe(2);
    expect(d.runs).toEqual([]);
    for (const text of d.logs) expect(text).not.toContain(SECRET);
  });

  test("RED CONTROL: a password on the command line is not an option; role lists are names only", () => {
    expect(parseWrapperArgs(["--target", "stage", "--doadmin", SECRET])).toMatchObject({ error: expect.stringContaining("unknown argument") });
    const bad = parseWrapperArgs(["--target", "stage", SECRET]);
    expect("error" in bad && !bad.error.includes(SECRET)).toBe(true);
    expect(parseWrapperArgs(["--target", "stage", "--roles", "rm_owner;rm -rf /"])).toMatchObject({ error: expect.stringContaining("comma-separated") });
    expect(parseWrapperArgs([])).toMatchObject({ error: expect.stringContaining("--target is required") });
  });
});
