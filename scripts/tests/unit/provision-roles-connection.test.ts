// How the provisioning script builds its connection, asserted by RUNNING it.
//
// The sibling file (provision-roles-no-rotation.test.ts) reads the script as
// TEXT, which is the right test for "no future edit reintroduces an
// unconditional \password". It cannot see what the script actually does with
// an env file, and that is where this session's failures lived:
//
//   * a `.env` pasted through a CRLF clipboard built
//     `postgres://doadmin@host<CR>:25060<CR>/defaultdb<CR>` -- a corruption
//     invisible in a terminal, and one scripts/lib/env-role.ts (the OTHER
//     reader of this same file) does not share, because it trims;
//   * the bootstrap password was injected into the URL and handed to psql as a
//     positional argument, i.e. into argv, while the script's header claimed it
//     "never ... accepts credentials as command-line arguments". It now travels
//     in a 0600 PGPASSFILE, removed on every exit path;
//   * with no password to inject, every psql call carried -W and prompted
//     SEPARATELY -- three times, four with --set-passwords -- so a fumbled
//     third prompt left 0053 and 0062 applied and the verification skipped.
//
// So this file runs the real script with a FAKE psql first on PATH, and reads
// back the argv and environment it was called with. No database is involved.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "ops", "provision-db-role-taxonomy.sh");

const DISCRETE = [
  "rm_app = app-pw",
  "rm_worker = worker-pw",
  "rm_readonly = ro-pw",
  "host = db.example.com",
  "port = 25060",
  "database = defaultdb",
  "sslmode = require",
].join("\n");

type Call = { argv: string; pgpass: string; pgpassPath: string };

/** What the stub found in the PGPASSFILE psql was pointed at, if any. */
function passwordOf(call: Call): string {
  const field = call.pgpass.split(":").slice(4).join(":");
  return field.replace(/\\(.)/g, "$1");
}

interface RunResult {
  exitCode: number;
  stderr: string;
  calls: Call[];
}

/**
 * Run the script with a stub `psql` that records its argv and the contents of
 * the PGPASSFILE it was handed.
 * stdin is closed, so the interactive prompt cannot block the suite -- the
 * no-credential case is asserted on its refusal, which is the behaviour that
 * matters for an unattended caller anyway.
 */
async function run(envText: string, args: string[] = []): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "provision-test-"));
  const envFile = join(dir, "provisioning.env");
  const log = join(dir, "psql.log");
  writeFileSync(envFile, envText);

  const stub = join(dir, "psql");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\n` +
      `pass=""\n` +
      `[[ -n "\${PGPASSFILE-}" && -r "\${PGPASSFILE}" ]] && pass="$(head -1 "\${PGPASSFILE}")"\n` +
      `printf '%s\\t%s\\t%s\\n' "$*" "$pass" "\${PGPASSFILE-}" >> ${JSON.stringify(log)}\n` +
      `exit 0\n`,
  );
  chmodSync(stub, 0o755);

  const proc = Bun.spawn(["bash", SCRIPT, ...args, envFile], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  let calls: Call[] = [];
  try {
    calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [argv, pgpass = "", pgpassPath = ""] = line.split("\t");
        return { argv: argv!, pgpass, pgpassPath };
      });
  } catch {
    calls = [];
  }
  return { exitCode, stderr, calls };
}

/** The `postgres://…` argument, which is the connection the script chose. */
function urlOf(call: Call): string {
  return call.argv.split(/\s+/).find((a) => a.startsWith("postgres://")) ?? "";
}

describe("the connection the provisioning script builds", () => {
  test("RED CONTROL: the stub is reached and records real calls", async () => {
    // Without this, every assertion below would pass on an empty call list.
    const { exitCode, calls } = await run(`${DISCRETE}\ndoadmin = admin-pw`);
    expect(exitCode).toBe(0);
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  test("the discrete-token form assembles the URL every other consumer would", async () => {
    // Same four tokens urlForRole() reads, same result -- one file, two
    // readers, one answer.
    const { calls } = await run(`${DISCRETE}\ndoadmin = admin-pw`);
    for (const call of calls) {
      expect(urlOf(call)).toBe("postgres://doadmin@db.example.com:25060/defaultdb?sslmode=require");
    }
  });

  test("CRLF line endings do not reach the URL", async () => {
    // env-role.ts trims each line; this script did not, and the carriage
    // return landed inside the hostname, the port and the database name.
    const { calls } = await run(`${DISCRETE}\ndoadmin = admin-pw`.replace(/\n/g, "\r\n"));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(urlOf(call)).toBe("postgres://doadmin@db.example.com:25060/defaultdb?sslmode=require");
      expect(passwordOf(call)).toBe("admin-pw");
    }
  });

  test("the password reaches psql through a PGPASSFILE, never through argv", async () => {
    // argv is world-readable through ps and /proc/<pid>/cmdline for the life
    // of the call. A 0600 file is not, and neither is it /proc/<pid>/environ.
    const { calls } = await run(`${DISCRETE}\ndoadmin = admin-pw`);
    for (const call of calls) {
      expect(passwordOf(call)).toBe("admin-pw");
      expect(call.argv).not.toContain("admin-pw");
    }
  });

  test("the PGPASSFILE is removed when the script exits", async () => {
    // It carries a live bootstrap credential; leaving it in /tmp is the kind
    // of debris an ops helper must not produce.
    const { calls } = await run(`${DISCRETE}\ndoadmin = admin-pw`);
    const path = calls[0]!.pgpassPath;
    expect(path).not.toBe("");
    expect(existsSync(path)).toBe(false);
  });

  test("POSTGRES_PASSWORD is still honoured, and still stays out of argv", async () => {
    const { calls } = await run(`${DISCRETE}\nPOSTGRES_PASSWORD=fallback-pw`);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(passwordOf(call)).toBe("fallback-pw");
      expect(call.argv).not.toContain("fallback-pw");
    }
  });

  test("--role redirects both the username and which line is read", async () => {
    const { calls } = await run(`${DISCRETE}\nbootstrap_admin = other-pw`, ["--role", "bootstrap_admin"]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(urlOf(call)).toBe("postgres://bootstrap_admin@db.example.com:25060/defaultdb?sslmode=require");
      expect(passwordOf(call)).toBe("other-pw");
    }
  });

  test("the credential is resolved ONCE — every psql call carries the same one", async () => {
    // The old shape passed -W to each invocation, so the operator was asked
    // for the same secret three times and a fumble on the last one skipped the
    // verification while leaving 0053 and 0062 applied.
    const { calls } = await run(`${DISCRETE}\ndoadmin = admin-pw`, ["--set-passwords"]);
    expect(new Set(calls.map(passwordOf))).toEqual(new Set(["admin-pw"]));
    expect(calls.some((c) => c.argv.includes("-W"))).toBe(false);
  });

  test("an unattended run with no credential REFUSES, naming the line to add", async () => {
    // It must not fall through to a psql prompt reading from a pipe.
    const { exitCode, stderr, calls } = await run(DISCRETE);
    expect(exitCode).toBe(64);
    expect(stderr).toContain("doadmin = <password>");
    expect(calls).toEqual([]);
  });

  test("0053 is applied before 0062, and a failure of either stops the run", async () => {
    const { calls } = await run(`${DISCRETE}\ndoadmin = admin-pw`);
    const files = calls.map((c) => c.argv.match(/migrations\/(\d{4})_/)?.[1]).filter(Boolean);
    expect(files).toEqual(["0053", "0062"]);
    // The verification is a separate, LAST call with no -f: it judges the end
    // state rather than being part of it.
    expect(calls.at(-1)!.argv).not.toContain("-f ");
  });

  test("a legacy URL env still works, and says out loud what it costs", async () => {
    const { calls, stderr } = await run(
      "MIGRATE_DATABASE_URL=postgres://doadmin:legacy-pw@db.example.com:25060/defaultdb?sslmode=require",
    );
    expect(calls.length).toBeGreaterThan(0);
    // Unchanged behaviour -- re-encoding a working credential is how you break
    // it -- but the argv exposure is now disclosed rather than denied.
    expect(urlOf(calls[0]!)).toContain("legacy-pw");
    expect(stderr).toMatch(/visible in ps/);
  });
});
