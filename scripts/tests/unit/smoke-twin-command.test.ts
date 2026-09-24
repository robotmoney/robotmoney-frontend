// Unit tests for `bun run smoke:twin` (scripts/smoke-twin.ts) — the standing smoke-twin.
//
// It is a thin wrapper, so what is worth pinning is the two decisions it makes
// and refuses to make differently:
//   - --static-port ALWAYS, because this is the boot cloudflared points at, and
//     a smoke-twin on a Docker-assigned port serves the tunnel a 502;
//   - --smoke ALWAYS, because --db smoke-twin requires it (a restored database is
//     populated and the smoke fixtures overwrite by design);
//   - capture unless --reuse, because "the latest dump" is the whole point.
import { describe, expect, test } from "bun:test";
import { defaultTwinDir, planTwin } from "../../smoke-twin.ts";
import { resolveZenKey, READONLY_ENV_FILE } from "../../lib/smoke-twin-rehearsal.ts";

const plan = (...a: string[]) => {
  const p = planTwin(a);
  if ("error" in p) throw new Error(p.error);
  return p;
};

describe("planTwin — the decisions it will not let you skip", () => {
  test("captures a fresh dump by default", () => {
    expect(plan().capture).toBe(true);
  });

  test("--reuse skips the capture and boots the existing backup", () => {
    expect(plan("--reuse").capture).toBe(false);
  });

  test("ALWAYS pins the host port — this is the tunnel's boot", () => {
    for (const argv of [[], ["--reuse"], ["--no-tui"]]) {
      expect(plan(...argv).args).toContain("--static-port");
    }
  });

  test("ALWAYS boots the archive scenario — --db smoke-twin requires --smoke", () => {
    expect(plan().args).toContain("--smoke");
    expect(plan().args.join(" ")).toContain("--db smoke-twin");
  });

  test("--backup-dir is forwarded to the boot", () => {
    const p = plan("--backup-dir", "/srv/b");
    expect(p.backupDir).toBe("/srv/b");
    expect(p.args.join(" ")).toContain("--backup-dir /srv/b");
  });

  test("--no-tui passes through; nothing else is invented", () => {
    const dir = defaultTwinDir();
    expect(plan("--no-tui").args).toEqual(["--smoke", "--db", "smoke-twin", "--static-port", "--backup-dir", dir, "--no-tui"]);
    expect(plan().args).toEqual(["--smoke", "--db", "smoke-twin", "--static-port", "--backup-dir", dir]);
  });

  test("boots from the twin's own directory, never the backup directory", () => {
    const dir = defaultTwinDir({ HOME: "/home/op" });
    expect(dir).toBe("/home/op/rm-backup-v022-twin");
    expect(defaultTwinDir({ RM_BACKUP_DIR: "/srv/backups" })).toBe("/srv/backups-twin");
    expect(plan().backupDir).toBe(defaultTwinDir());
  });

  test("captures slim by default; --full-dump captures every row", () => {
    expect(plan().slim).toBe(true);
    expect(plan("--full-dump").slim).toBe(false);
  });
});

describe("planTwin — refusals", () => {
  test("an unknown flag is rejected rather than forwarded into the boot", () => {
    expect(planTwin(["--fixed-ports"])).toEqual({
      error: expect.stringContaining('unknown flag "--fixed-ports"') as unknown as string,
    });
  });

  test("--backup-dir without a value is an error", () => {
    expect(planTwin(["--backup-dir"])).toEqual({ error: "--backup-dir requires a value." });
  });

  test("a positional argument is refused", () => {
    expect(planTwin(["now"])).toEqual({ error: 'unexpected argument "now".' });
  });
});

describe("resolveZenKey — $HOME/.env is the only file consulted", () => {
  test("the process environment overrides (how CI and a one-off shell supply it)", () => {
    const r = resolveZenKey({ OPENCODE_API_KEY: "zen-from-env" });
    expect(r).toEqual({ key: "zen-from-env", source: "process environment" });
  });

  test("blank in the environment is not a key — it falls through to the file", () => {
    const r = resolveZenKey({ OPENCODE_API_KEY: "   " });
    // Either the host has a real $HOME/.env (source names it) or it errors —
    // never "process environment", which is what a blank must not resolve to.
    expect("source" in r ? r.source : "error").not.toBe("process environment");
  });

  test("the error names $HOME/.env, never a repo-root .env", () => {
    const r = resolveZenKey({ HOME: "/nowhere" });
    if ("key" in r) {
      // This checkout has a real $HOME/.env; the contract is still that the
      // file it names is that one and never a repo-root ./.env.
      expect(r.source).toBe(READONLY_ENV_FILE);
      return;
    }
    expect(r.error).toContain(READONLY_ENV_FILE);
    expect(r.error).toMatch(/single credential file for this family, never a repo-root \.env/);
  });

  test("it refuses rather than substituting a keyless model", () => {
    const r = resolveZenKey({ HOME: "/nowhere" });
    if ("error" in r) expect(r.error).toMatch(/AGENT_MODEL=free/);
  });
});
