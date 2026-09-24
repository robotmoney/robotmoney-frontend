// Unit tests for `bun run smoke:twin` (scripts/smoke-twin.ts) — the standing smoke-twin.
//
// It is a thin wrapper, so what is worth pinning is the two decisions it makes
// and refuses to make differently:
//   - --static-port ALWAYS, because this is the boot cloudflared points at, and
//     a smoke-twin on a Docker-assigned port serves the tunnel a 502;
//   - `--local dump` ALWAYS, because a twin is a restored production copy (spec
//     §5), and never a retired spelling (`--smoke`, `--db`, `--backup-dir`,
//     `--no-tui`) that the boot now refuses by name;
//   - --cadence fast ALWAYS, because a twin is a TEST boot — production-shaped
//     data run at the short ~2-min test cadence, never the 6 h production cadence
//     the port pin alone would select;
//   - capture unless --reuse, because "the latest dump" is the whole point.
import { describe, expect, test } from "bun:test";
import { planTwin } from "../../smoke-twin.ts";
import { RETIRED_FLAGS, validateArgv } from "../../smoke.ts";
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
    for (const argv of [[], ["--reuse"]]) {
      expect(plan(...argv).args).toContain("--static-port");
    }
  });

  test("ALWAYS boots a local dump, and hands the boot no retired flag", () => {
    expect(plan().args.join(" ")).toContain("--local dump");

    for (const argv of [[], ["--reuse"], ["--backup-dir", "/srv/b"]]) {
      for (const r of RETIRED_FLAGS) expect({ argv, flag: r.flag, in: plan(...argv).args.includes(r.flag) }).toEqual({ argv, flag: r.flag, in: false });
    }
  });

  test("ALWAYS runs the short TEST cadence — --cadence fast, never the 6 h profile", () => {
    for (const argv of [[], ["--reuse"]]) {
      const p = plan(...argv);
      expect(p.args.join(" ")).toContain("--cadence fast");
      expect(p.args.join(" ")).not.toContain("--cadence realistic");
    }
  });

  test("--backup-dir is forwarded to the boot as the dump's directory", () => {
    const p = plan("--backup-dir", "/srv/b");
    expect(p.backupDir).toBe("/srv/b");
    expect(p.args).toEqual(["--local", "dump=/srv/b", "--static-port", "--cadence", "fast"]);
  });

  test("nothing else is invented", () => {
    expect(plan().args).toEqual(["--local", "dump", "--static-port", "--cadence", "fast"]);
  });

  test("the plan the wrapper hands the boot passes the boot's own validator", () => {

    for (const argv of [[], ["--backup-dir", "/srv/b"]]) {
      expect(validateArgv(["bun", "scripts/smoke.ts", ...plan(...argv).args])).toEqual([]);
    }
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

  test("--no-tui is refused: there is no TUI to turn off (spec §1)", () => {
    expect(planTwin(["--no-tui"])).toEqual({
      error: expect.stringContaining('unknown flag "--no-tui"') as unknown as string,
    });
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
