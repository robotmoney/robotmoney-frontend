// Unit tests for the `--local <mode>` data-path resolver and the argv allowlist
// (scripts/lib/smoke-db-mode.ts).
//
// Imported from scripts/smoke.ts — the `bun smoke` entrypoint re-exports the
// module and only triggers the side-effectful bring-up under `import.meta.main`,
// so this import is safe and proves the tested resolver is exactly the one the
// smoke consumes (same arrangement as smoke-env.test.ts).
//
// Contract under test (smoke-production-spec §1, §5):
//   - No flag is the remote database; `--local` takes a REQUIRED mode:
//     blank | dump[=<dir>] | volume[=<name>]. A bare `--local` or a path refuses.
//   - Every flag §1 retires with no alias, and SMOKE_PROJECT, is REFUSED by
//     name, never warned about and never accepted.
//   - No mode implies `--seed` (or `--migrate`); `--seed` refuses a populated
//     database, which a dump and a reattached volume are.
//   - Unknown flags are ERRORS. They used to be ignored, which booted the
//     default data path while looking like the one that was asked for.
//   - ownsData() and usesComposePostgres() are DIFFERENT questions; the dump is
//     the case that proves it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bannerFor,
  LOCK_TIMEOUT_DEFAULT_SECONDS,
  LOCK_TIMEOUT_FLAG,
  lockTimeoutMs,
  cadenceOverride,
  keptDataDescription,
  dataPathOverlayYaml,
  LOCAL_MODES,
  localModeOf,
  MIGRATE_FLAG,
  ownsData,
  parseDataPath,
  parseLocalMode,
  parseVolumeHolders,
  reattachOverlayYaml,
  refuseRetiredEnv,
  refuseVolumeInUse,
  requestsDump,
  requestsMigrate,
  requestsSeed,
  RETIRED_ENV,
  RETIRED_FLAGS,
  SEED_FLAG,
  shouldSeed,
  usesComposePostgres,
  validateArgv,
  type ResolvedDataPath,
} from "../../smoke.ts";

/** argv as bun hands it over: [runtime, script, ...flags]. */
const argv = (...flags: string[]): string[] => ["bun", "scripts/smoke.ts", ...flags];

function envFileWith(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-db-mode-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents);
  return path;
}

const REAL_ENV = envFileWith(
  "host = db.example.com\nport = 25060\ndatabase = defaultdb\nrm_app = hunter2secret\n",
);
const NO_ENV = join(tmpdir(), "rm-db-mode-absent", ".env");
const parse = (a: string[], envFilePath = REAL_ENV) => parseDataPath(a, { envFilePath });

describe("the default and the three local modes", () => {
  test("no flag → the remote database (the default), resolved from the $HOME/.env FILE", () => {
    const { dataPath } = parse(argv());
    expect(dataPath).toMatchObject({ kind: "external", host: "db.example.com", source: "discrete keys" });
  });

  test("--local blank → a fresh local database", () => {
    expect(parse(argv("--local", "blank")).dataPath).toEqual({ kind: "ephemeral" });
    expect(parse(argv("--local=blank")).dataPath).toEqual({ kind: "ephemeral" });
  });

  test("--local dump → a restored dump (today's smoke-twin path), with an optional directory", () => {
    expect(parse(argv("--local", "dump")).dataPath).toEqual({ kind: "smoke-twin" });
    expect(parse(argv("--local", "dump=/srv/backups")).dataPath).toEqual({ kind: "smoke-twin", backupDir: "/srv/backups" });
    expect(parse(argv("--local=dump=/srv/backups")).dataPath).toEqual({ kind: "smoke-twin", backupDir: "/srv/backups" });
  });

  test("--local volume → the compose postgres reattached to a saved volume, named or not", () => {
    expect(parse(argv("--local", "volume")).dataPath).toEqual({ kind: "ephemeral", reattach: {} });
    expect(parse(argv("--local", "volume=rm_smoke_stack_ab_pgdata")).dataPath).toEqual({
      kind: "ephemeral",
      reattach: { volume: "rm_smoke_stack_ab_pgdata" },
    });
  });

  test("the modes are exactly the spec's three", () => {
    expect([...LOCAL_MODES]).toEqual(["blank", "dump", "volume"]);
  });

  test("requestsDump answers from argv alone and never throws on a bad value", () => {
    expect(requestsDump(argv("--local", "dump"))).toBe(true);
    expect(requestsDump(argv("--local", "dump=/x"))).toBe(true);
    expect(requestsDump(argv("--local", "blank"))).toBe(false);
    expect(requestsDump(argv())).toBe(false);
    expect(requestsDump(argv("--local", "/srv/pg"))).toBe(false);
  });
});

describe("--local takes a mode, never a path (criterion 28's parse half)", () => {
  test("a bare --local refuses and names the three modes", () => {
    expect(() => parse(argv("--local"))).toThrow(/requires a mode: one of blank \| dump \| volume/);
    expect(() => parse(argv("--local", SEED_FLAG))).toThrow(/requires a mode/);
  });

  test("--local <path> refuses — it used to bind-mount a directory named after the token", () => {
    // RED CONTROL for the old reading: `blank` and `volume` WERE read as paths,
    // so the spec's own spelling booted a relative bind called `blank`. Now a
    // path is the thing that refuses, and the spec's words are modes.
    for (const path of ["/srv/pg", "./pgdata", "blank-dir"]) {
      expect(() => parse(argv("--local", path))).toThrow(/not a local mode/);
      expect(() => parse(argv(`--local=${path}`))).toThrow(/not a local mode/);
    }
  });

  test("a near-miss mode gets a suggestion", () => {
    expect(() => parseLocalMode("volum")).toThrow(/Did you mean "volume"/);
  });

  test("blank takes no value; dump= and volume= require one", () => {
    expect(() => parseLocalMode("blank=x")).toThrow(/takes no value/);
    expect(() => parseLocalMode("dump=")).toThrow(/requires a value/);
    expect(() => parseLocalMode("volume=")).toThrow(/requires a value/);
  });

  test("a reattach overlay names the volume as external and refuses a non-volume name", () => {
    const yaml = reattachOverlayYaml("rm_smoke_stack_ab_pgdata");
    expect(yaml).toContain("external: true");
    expect(yaml).toContain("name: rm_smoke_stack_ab_pgdata");
    expect(yaml).toContain(":/var/lib/postgresql/data");
    expect(() => reattachOverlayYaml("../etc")).toThrow(/not a Docker volume name/);
  });
});

describe("retired flags and SMOKE_PROJECT are REFUSED by name (criterion 4)", () => {
  const SPEC_RETIRED = ["--no-tui", "--agents", "--smoke", "--db", "--pg-data", "--twin"];

  test("every flag spec §1 retires is on the refusal list", () => {
    const listed = RETIRED_FLAGS.map((r) => r.flag);
    for (const f of SPEC_RETIRED) expect(listed).toContain(f);
  });

  test.each([
    [["--twin"], "--twin"],
    [["--agents", "athena"], "--agents"],
    [["--agents=athena,themis"], "--agents"],
    [["--no-tui"], "--no-tui"],
    [["--db", "external"], "--db"],
    [["--db=smoke-twin"], "--db"],
    [["--pg-data", "/srv/pg"], "--pg-data"],
    [["--smoke"], "--smoke"],
    [["--backup-dir", "/srv/b"], "--backup-dir"],
    [["--stage"], "--stage"],
  ] as const)("%j is refused naming %s, as one error with no stray positional", (flags, name) => {
    const errors = validateArgv(argv(...flags));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${name} is retired with no alias`);
    expect(() => parse(argv(...flags))).toThrow(new RegExp(`${name} is retired with no alias`));
  });

  test("a retired flag alongside valid ones still refuses the whole boot", () => {
    expect(() => parse(argv("--local", "blank", "--no-tui", SEED_FLAG))).toThrow(/--no-tui is retired/);
  });

  test("SMOKE_PROJECT set to anything, even empty, is refused naming it", () => {
    for (const value of ["rm_prod", "", "rm_ci_stack_1_1"]) {
      const refusal = refuseRetiredEnv({ [RETIRED_ENV]: value });
      expect(refusal).toContain("SMOKE_PROJECT is retired with no alias");
    }
  });

  test("an environment without SMOKE_PROJECT is not refused", () => {
    expect(refuseRetiredEnv({ PATH: "/usr/bin", RM_ENV: "stage" })).toBeNull();
  });

  test("red control: the refusal is the retired list's, not the unknown-flag path", () => {
    // `--fixed-ports` never existed, so it is UNKNOWN, not retired: the two
    // paths must stay distinguishable or the retired message proves nothing.
    expect(validateArgv(argv("--fixed-ports")).join(" ")).toMatch(/unknown flag "--fixed-ports"/);
    expect(validateArgv(argv("--fixed-ports")).join(" ")).not.toMatch(/retired/);
  });
});

describe("loud refusals — every one before any restore work", () => {
  test("--seed with a dump is refused — a restored dump is populated", () => {
    expect(() => parse(argv("--local", "dump", SEED_FLAG))).toThrow(/refuses a populated database/);
  });

  test("--seed with a reattached volume is refused — it is populated too", () => {
    expect(() => parse(argv("--local", "volume", SEED_FLAG))).toThrow(/refuses a populated database/);
  });

  test("the remote database with an unreadable ~/.env fails loudly, never falls back", () => {
    expect(() => parse(argv(), NO_ENV)).toThrow(/no readable \$HOME\/\.env/);
  });

  test("--migrate parses cleanly on every data path", () => {
    expect(parse(argv(MIGRATE_FLAG)).dataPath.kind).toBe("external");
    expect(parse(argv("--local", "dump", MIGRATE_FLAG)).dataPath.kind).toBe("smoke-twin");
    expect(parse(argv("--local", "blank", MIGRATE_FLAG)).dataPath.kind).toBe("ephemeral");
  });

  test("--seed parses cleanly on the remote and blank databases", () => {
    expect(parse(argv(SEED_FLAG)).dataPath.kind).toBe("external");
    expect(parse(argv("--local", "blank", SEED_FLAG)).dataPath).toEqual({ kind: "ephemeral" });
  });

  test("--migrate and --seed are independent, and combine", () => {
    expect(parse(argv("--local", "blank", MIGRATE_FLAG, SEED_FLAG)).dataPath.kind).toBe("ephemeral");
    expect(requestsMigrate(argv(SEED_FLAG))).toBe(false);
    expect(requestsSeed(argv(MIGRATE_FLAG))).toBe(false);
  });

  test("no env var can select a data path — only the flags do", () => {
    const before = process.env.DB;
    process.env.DB = "smoke-twin";
    try {
      expect(parse(argv()).dataPath.kind).toBe("external");
      expect(parse(argv("--local", "blank")).dataPath.kind).toBe("ephemeral");
    } finally {
      if (before === undefined) delete process.env.DB;
      else process.env.DB = before;
    }
  });
});

describe("validateArgv — unknown flags are errors, not silence", () => {
  test("--fixed-ports is rejected (the flag that never existed and booted green)", () => {
    const errors = validateArgv(argv("--local", "blank", "--fixed-ports"));
    expect(errors).toHaveLength(1);
    expect(errors.join(" ")).toMatch(/unknown flag "--fixed-ports"/);
  });

  test("a near-miss flag gets a suggestion", () => {
    expect(validateArgv(argv("--migrat")).join(" ")).toMatch(/--migrate/);
  });

  test("a clean invocation passes", () => {
    expect(validateArgv(argv("--local", "blank", MIGRATE_FLAG, SEED_FLAG))).toEqual([]);
    expect(validateArgv(argv("--static-port"))).toEqual([]);
    expect(validateArgv(argv("--local", "dump=/srv/b", "--static-port", "--cadence", "fast"))).toEqual([]);
  });

  test("--cadence is a known arity-1 flag (the fast dump's override)", () => {
    expect(validateArgv(argv("--cadence", "fast"))).toEqual([]);
    expect(validateArgv(argv("--cadence=realistic"))).toEqual([]);
    expect(validateArgv(argv("--cadence")).join(" ")).toMatch(/requires a value/);
  });

  test("cadenceOverride reads the value and THROWS on anything but fast|realistic", () => {
    expect(cadenceOverride(argv("--cadence", "fast"))).toBe("fast");
    expect(cadenceOverride(argv("--cadence=realistic"))).toBe("realistic");
    expect(cadenceOverride(argv("--local", "blank"))).toBeUndefined();
    expect(() => cadenceOverride(argv("--cadence", "overnight"))).toThrow(/--cadence accepts "fast" or "realistic"/);
  });

  test("parseDataPath surfaces the cadence override, and a bad value fails at parse time", () => {
    expect(parse(argv("--cadence", "fast")).cadence).toBe("fast");
    expect(parse(argv("--cadence=realistic")).cadence).toBe("realistic");
    expect(parse(argv("--local", "blank")).cadence).toBeUndefined();
    expect(() => parse(argv("--cadence", "overnight"))).toThrow(/--cadence accepts "fast" or "realistic"/);
  });

  test("an arity-1 flag's value is consumed, not read as a positional", () => {
    expect(validateArgv(argv("--images-override", "/srv/o.yml"))).toEqual([]);
  });

  test("a switch given a value is an error", () => {
    expect(validateArgv(argv("--migrate=yes")).join(" ")).toMatch(/takes no value/);
  });

  test("positional arguments are refused", () => {
    expect(validateArgv(argv("please-boot")).join(" ")).toMatch(/positional/);
  });

  test("every problem is reported, not just the first", () => {
    expect(validateArgv(argv("--nope", "--also-nope"))).toHaveLength(2);
  });

  test("parseDataPath refuses an argv the validator rejects", () => {
    expect(() => parse(argv("--fixed-ports"))).toThrow(/unknown flag/);
  });
});

describe("ownsData vs usesComposePostgres — two questions, not one", () => {
  test.each([
    ["ephemeral", true, true],
    ["external", false, false],
    ["smoke-twin", true, false],
  ] as const)("%s: ownsData=%s usesComposePostgres=%s", (kind, owns, compose) => {
    expect(ownsData({ kind })).toBe(owns);
    expect(usesComposePostgres({ kind })).toBe(compose);
  });

  test("the dump is the case that proves they differ", () => {
    expect(ownsData({ kind: "smoke-twin" })).not.toBe(usesComposePostgres({ kind: "smoke-twin" }));
  });
});

describe("requestsMigrate / requestsSeed — bare switches, argv-only", () => {
  test("true only when present", () => {
    expect(requestsMigrate(argv(MIGRATE_FLAG))).toBe(true);
    expect(requestsMigrate(argv())).toBe(false);
    expect(requestsSeed(argv(SEED_FLAG))).toBe(true);
    expect(requestsSeed(argv())).toBe(false);
  });
});

describe("shouldSeed — no mode implies --seed (criterion 52)", () => {
  test.each([[[]], [["--local", "blank"]], [["--local", "dump"]], [["--local", "volume"]]] as const)(
    "%j without --seed does not seed",
    (flags) => {
      expect(shouldSeed(argv(...flags))).toBe(false);
    },
  );

  test("--seed seeds", () => {
    expect(shouldSeed(argv(SEED_FLAG))).toBe(true);
    expect(shouldSeed(argv("--local", "blank", SEED_FLAG))).toBe(true);
  });
});

const TWIN: ResolvedDataPath = {
  kind: "smoke-twin",
  url: "postgres://restore_check:rk_secretpass@172.17.0.1:49155/rm_restore_check",
  redactedUrl: "postgres://restore_check:***@172.17.0.1:49155/rm_restore_check",
  container: "rm-restore-20260821T101500Z-a3f9c1",
  volume: "rm_smoke_smoke-twindata",
  stamp: "20260821T101500Z",
};
const EXTERNAL: ResolvedDataPath = {
  kind: "external",
  url: "postgres://rm_app:hunter2secret@db.example.com:25060/defaultdb",
  redactedUrl: "postgres://rm_app:***@db.example.com:25060/defaultdb",
  host: "db.example.com",
  source: "discrete keys",
};

describe("the generated overlay", () => {
  test.each([TWIN, EXTERNAL])("$kind removes the service, the volume and the edges", (dp) => {
    const yaml = dataPathOverlayYaml(dp);
    expect(yaml).toContain("  postgres: !reset null");
    expect(yaml).toContain("  pgdata: !reset null");
    // Exactly the services that HOLD a database connection. `system-scheduler`
    // is not among them and must not be: it has no `depends_on: postgres` to
    // reset because it has no database at all (system-scheduler-spec.md §1).
    for (const s of ["api", "worker-analytics", "worker-research"]) {
      expect(yaml).toContain(`  ${s}:\n    depends_on: !reset null`);
    }
  });

  test("the dump overlay names itself, so a stray file on disk is attributable", () => {
    expect(dataPathOverlayYaml(TWIN)).toContain("--local dump");
    expect(dataPathOverlayYaml(TWIN)).toContain(TWIN.container);
  });

  test("no overlay carries a password", () => {
    expect(dataPathOverlayYaml(TWIN)).not.toContain("rk_secretpass");
    expect(dataPathOverlayYaml(EXTERNAL)).not.toContain("hunter2secret");
  });

  test("an ephemeral boot has no overlay to generate", () => {
    expect(() => dataPathOverlayYaml({ kind: "ephemeral" })).toThrow(/needs no overlay/);
  });
});

describe("the banner states the consequence of THIS mode", () => {
  test("external says teardown cannot undo it", () => {
    expect(bannerFor(EXTERNAL)).toMatch(/can undo/);
    expect(bannerFor(EXTERNAL)).toMatch(/SOMEONE ELSE'S/);
  });

  test("smoke-twin says the copy OUTLIVES the boot and names the reclaim command", () => {
    const b = bannerFor(TWIN);
    expect(b).toMatch(/OUTLIVES THIS BOOT/);
    expect(b).toMatch(/smoke:clean/);
    expect(b).toMatch(/credential material/);
  });

  test("smoke-twin does not borrow external's wording — the two are opposites", () => {
    expect(bannerFor(TWIN)).not.toMatch(/SOMEONE ELSE'S/);
  });

  test("no banner leaks a password", () => {
    expect(bannerFor(TWIN)).not.toContain("rk_secretpass");
    expect(bannerFor(EXTERNAL)).not.toContain("hunter2secret");
  });
});

describe("keptDataDescription — what teardown actually kept", () => {
  test("a blank boot names the compose volume", () => {
    expect(keptDataDescription({ kind: "ephemeral" }, "p")).toBe("volume p_pgdata");
  });

  test("a reattached boot names the volume it reattached instead", () => {
    expect(keptDataDescription({ kind: "ephemeral", reattach: { volume: "saved_pgdata" } }, "p")).toBe("volume saved_pgdata");
  });

  test("a dump names its OWN volume, never a pgdata it never created", () => {
    expect(keptDataDescription(TWIN, "p")).toBe(`dump volume ${TWIN.volume}`);
    expect(keptDataDescription(TWIN, "p")).not.toContain("pgdata");
  });

  test("external kept NOTHING — the pre-union bug was claiming otherwise", () => {
    // cleanup() used to name `<project>_pgdata` unconditionally, so an external
    // boot reported keeping a volume it had never created and sent smoke:clean
    // after storage that does not exist.
    expect(keptDataDescription(EXTERNAL, "p")).toBeUndefined();
  });
});

describe("remote-database refusals never name the retired --db flag (criterion 4)", () => {
  // Plain `bun smoke` (no --local) reaches the remote resolver through a
  // synthetic argv; every refusal it can throw is exercised here.
  const cases: Array<[string, string]> = [
    ["no ~/.env", NO_ENV],
    ["no rm_app role line", envFileWith("host = db.example.com\nport = 25060\ndatabase = defaultdb\n")],
    ["host is the compose service", envFileWith("host = postgres\nport = 5432\ndatabase = defaultdb\nrm_app = x\n")],
    ["host is loopback", envFileWith("host = localhost\nport = 5432\ndatabase = defaultdb\nrm_app = x\n")],
  ];
  const messageOf = (envFile: string): string => {
    try {
      parse(argv(), envFile);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return "";
  };

  for (const [name, envFile] of cases) {
    test(`${name}: refused, naming the remote database and not --db`, () => {
      const msg = messageOf(envFile);
      expect(msg).toContain("remote database (no --local flag)");
      expect(msg).not.toContain("--db");
      expect(msg).not.toMatch(/this flag/i);
    });
  }

  test("red control: the retired prefix would be caught", () => {
    expect("--db external: no readable $HOME/.env").toContain("--db");
  });
});

// SCHEMA CURRENCY ON EVERY PATH (criterion 28) is no longer a per-path
// decision here. bootPreflightPlan() chose between two container one-shots
// (schema-current.ts, db-preflight.ts's classification) by path; both are
// superseded and gone. Every boot now runs the FULL §7 preflight after its
// preparation (backend/scripts/smoke-prepare.ts `preflight`), whose check 3
// asks of any database whether its schema matches its manifest (3a) and whether
// the booting code supports it (3b) — on every path, `--migrate` or not — and
// `--seed`'s populated-database refusal is the seed gate
// (backend/tests/seed-gate.test.ts). The runtime proof is the preflight results
// a real boot writes to its receipt (scripts/tests/integration/smoke-lifecycle).

describe("--lock-timeout — the bounded wait behind another target-lock holder (spec §2, criterion 36)", () => {
  test("absent: the default, in milliseconds", () => {
    expect(lockTimeoutMs(argv())).toBe(LOCK_TIMEOUT_DEFAULT_SECONDS * 1000);
  });

  test("seconds, in either spelling", () => {
    expect(lockTimeoutMs(argv(LOCK_TIMEOUT_FLAG, "5"))).toBe(5000);
    expect(lockTimeoutMs(argv(`${LOCK_TIMEOUT_FLAG}=0.5`))).toBe(500);
  });

  test("a value that is not a number of seconds refuses rather than waiting forever", () => {
    for (const bad of ["forever", "1m", "5s"]) {
      expect(() => lockTimeoutMs(argv(LOCK_TIMEOUT_FLAG, bad))).toThrow(`takes a number of seconds, got "${bad}"`);
    }
    // A negative number or a missing value never reaches the parser: the argv
    // allowlist refuses both (a value may not start with `--`, and `=` needs one).
    expect(validateArgv(argv(`${LOCK_TIMEOUT_FLAG}=`))).not.toEqual([]);
    expect(validateArgv(argv(LOCK_TIMEOUT_FLAG))).not.toEqual([]);
  });

  test("it is an accepted flag, so the argv allowlist lets it through", () => {
    expect(validateArgv(argv("--local", "blank", LOCK_TIMEOUT_FLAG, "5"))).toEqual([]);
  });
});

describe("localModeOf — the mode a refusal speaks about", () => {
  const DUMP: ResolvedDataPath = { kind: "smoke-twin", url: "postgres://u:p@172.17.0.1:5555/d", redactedUrl: "x", container: "c", volume: "v", stamp: "s" };

  test("localModeOf names the mode a refusal should speak about", () => {
    expect(localModeOf(DUMP)).toBe("dump");
    expect(localModeOf({ kind: "ephemeral", reattach: { volume: "v" } })).toBe("volume");
    expect(localModeOf({ kind: "ephemeral" })).toBe("blank");
    expect(localModeOf({ kind: "external" } as ResolvedDataPath)).toBeNull();
  });
});

describe("refuseVolumeInUse — no second postgres on a mounted volume (criterion 28)", () => {
  test("no running holder: allowed", () => {
    expect(refuseVolumeInUse("rm_smoke_stack_abc_pgdata", [])).toBeNull();
    expect(refuseVolumeInUse("rm_smoke_stack_abc_pgdata", parseVolumeHolders(""))).toBeNull();
  });

  test("a running holder: refused, naming the container, its project and how to stop it", () => {
    const holders = parseVolumeHolders("rm_smoke_stack_abc-postgres-1\trm_smoke_stack_abc\n");
    expect(holders).toEqual([{ container: "rm_smoke_stack_abc-postgres-1", project: "rm_smoke_stack_abc" }]);
    const msg = refuseVolumeInUse("rm_smoke_stack_abc_pgdata", holders);
    expect(msg).not.toBeNull();
    expect(msg!).toContain("rm_smoke_stack_abc-postgres-1");
    expect(msg!).toContain("project rm_smoke_stack_abc");
    expect(msg!).toContain("bun smoke:down");
    expect(msg!).toContain("docker compose -p rm_smoke_stack_abc down");
    expect(msg!).toContain("never with -v");
  });

  test("a holder outside compose (no project label) is still refused", () => {
    const msg = refuseVolumeInUse("v", parseVolumeHolders("stray-pg\t\n"));
    expect(msg).toContain("stray-pg");
    expect(msg).toContain("docker stop <container>");
  });

  test("red control: blank lines in docker's output are not holders", () => {
    expect(parseVolumeHolders("\n  \n")).toEqual([]);
  });

  test("smoke-main.ts asks Docker, and refuses, before writing the reattach overlay", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "lib", "smoke-main.ts"), "utf8");
    const ask = src.indexOf("refuseVolumeInUse(volume, parseVolumeHolders(");
    const overlay = src.indexOf("writeFileSync(overrideFile, reattachOverlayYaml(");
    expect(ask).toBeGreaterThan(0);
    expect(overlay).toBeGreaterThan(0);
    expect(ask).toBeLessThan(overlay);
    expect(src).toContain('"docker", "ps", "--filter", `volume=${volume}`');
  });
});
