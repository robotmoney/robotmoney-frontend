// Unit tests for the `--db` data-path resolver and the argv allowlist
// (scripts/lib/smoke-db-mode.ts).
//
// Imported from scripts/smoke.ts — the `bun run smoke` entrypoint re-exports the
// module and only triggers the side-effectful bring-up under `import.meta.main`,
// so this import is safe and proves the tested resolver is exactly the one the
// smoke consumes (same arrangement as smoke-env.test.ts and ).
//
// Contract under test:
//   - THREE named modes, one flag. Default is ephemeral; no env var can change it.
//   - Every invalid combination is refused AT PARSE TIME, before any restore
//     work — a smoke-twin that discovers its own invalidity after a multi-minute
//     pg_restore has already wasted the window it exists to protect.
//   - Unknown flags are ERRORS. They used to be ignored, which booted the
//     default data path while looking like the one that was asked for.
//   - `--external-pg` still works, and says it is deprecated.
//   - ownsData() and usesComposePostgres() are DIFFERENT questions; the smoke-twin is
//     the case that proves it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bannerFor,
  DB_FLAG,
  keptDataDescription,
  DB_MODES,
  dataPathOverlayYaml,
  MIGRATE_FLAG,
  ownsData,
  parseDataPath,
  requestsMigrate,
  requestsSeed,
  SEED_FLAG,
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

describe("default and the three modes", () => {
  test("no flag → the remote database (the default), and no warning", () => {
    const { dataPath, warnings } = parse(argv());
    expect(dataPath.kind).toBe("external");
    expect(warnings).toEqual([]);
  });

  test("--local → a fresh local database", () => {
    expect(parse(argv("--local")).dataPath).toEqual({ kind: "ephemeral" });
  });

  test("--local <path> → a local database on a saved volume", () => {
    expect(parse(argv("--local", "/srv/pg")).dataPath).toEqual({ kind: "ephemeral", pgDataDir: "/srv/pg" });
    expect(parse(argv("--local=/srv/pg")).dataPath).toEqual({ kind: "ephemeral", pgDataDir: "/srv/pg" });
  });

  test("--twin → a smoke-twin, no scenario flag needed", () => {
    expect(parse(argv("--twin")).dataPath.kind).toBe("smoke-twin");
  });

  test("--twin and --local are mutually exclusive", () => {
    expect(() => parse(argv("--twin", "--local"))).toThrow(/mutually exclusive/);
  });

  test("the deprecated --db / --pg-data / --smoke spellings still work, with a warning", () => {
    expect(parse(argv(DB_FLAG, "ephemeral")).warnings.join(" ")).toMatch(/--db is deprecated/);
    expect(parse(argv("--pg-data", "/srv/pg")).warnings.join(" ")).toMatch(/--pg-data is deprecated/);
    expect(parse(argv("--twin", "--smoke")).warnings.join(" ")).toMatch(/--smoke is deprecated/);
  });

  for (const mode of DB_MODES) {
    test(`--db ${mode} parses`, () => {
      const extra = mode === "smoke-twin" ? ["--smoke"] : [];
      expect(parse(argv(DB_FLAG, mode, ...extra)).dataPath.kind).toBe(mode);
    });
  }

  test("--db=smoke-twin (inline form) parses the same as --db smoke-twin", () => {
    expect(parse(argv(`${DB_FLAG}=smoke-twin`, "--smoke")).dataPath.kind).toBe("smoke-twin");
  });

  test("--db external resolves the address from the .env FILE", () => {
    const dp = parse(argv(DB_FLAG, "external")).dataPath;
    expect(dp).toMatchObject({ kind: "external", host: "db.example.com", source: "discrete keys" });
  });

  test("--db smoke-twin carries the backup dir when one is named", () => {
    const dp = parse(argv(DB_FLAG, "smoke-twin", "--smoke", "--backup-dir", "/srv/backups")).dataPath;
    expect(dp).toEqual({ kind: "smoke-twin", backupDir: "/srv/backups" });
  });

  test("--pg-data rides on the ephemeral variant", () => {
    expect(parse(argv("--pg-data", "/srv/pg")).dataPath).toEqual({
      kind: "ephemeral",
      pgDataDir: "/srv/pg",
    });
  });
});

describe("loud refusals — every one before any restore work", () => {
  test("--db with no value names the three modes", () => {
    expect(() => parse(argv(DB_FLAG))).toThrow(/requires a value/);
  });

  test("a typo'd mode is refused and suggests the real one", () => {
    expect(() => parse(argv(DB_FLAG, "twni", "--smoke"))).toThrow(/smoke-twin/);
  });

  test("a twin no longer needs a scenario flag — it implies its own", () => {
    expect(parse(argv("--twin")).dataPath.kind).toBe("smoke-twin");
    expect(parse(argv(DB_FLAG, "smoke-twin")).dataPath.kind).toBe("smoke-twin");
  });

  test("a database path with a twin is refused", () => {
    expect(() => parse(argv("--twin", "--pg-data", "/srv/pg"))).toThrow(/only applies to a local database/);
  });

  test("a database path with the remote database is refused", () => {
    expect(() => parse(argv("--pg-data", "/srv/pg", DB_FLAG, "external"))).toThrow(
      /only applies to a local database/,
    );
  });

  test("--seed with a twin is refused — a twin is already full", () => {
    expect(() => parse(argv("--twin", SEED_FLAG))).toThrow(/nothing to seed/);
  });

  test("--backup-dir without a smoke-twin is refused", () => {
    expect(() => parse(argv("--backup-dir", "/srv/backups"))).toThrow(/only applies/);
  });

  test("--db external with an unreadable .env fails loudly, never falls back", () => {
    expect(() => parse(argv(DB_FLAG, "external"), NO_ENV)).toThrow(/no readable \$HOME\/\.env/);
  });

  test("--migrate on the default (remote) database parses cleanly", () => {
    expect(parse(argv(MIGRATE_FLAG)).dataPath.kind).toBe("external");
  });

  test("--migrate on a twin parses cleanly — a twin may be migrated", () => {
    expect(parse(argv("--twin", MIGRATE_FLAG)).dataPath.kind).toBe("smoke-twin");
  });

  test("--seed on the default (remote) database parses cleanly", () => {
    expect(parse(argv(SEED_FLAG)).dataPath.kind).toBe("external");
  });

  test("--seed on a local database parses cleanly", () => {
    expect(parse(argv("--local", SEED_FLAG)).dataPath).toEqual({ kind: "ephemeral" });
  });

  test("--migrate and --seed are independent, and combine", () => {
    // A fresh remote database needs both; a restart of a populated one needs
    // neither. The flags do not imply each other.
    expect(parse(argv(MIGRATE_FLAG, SEED_FLAG)).dataPath.kind).toBe("external");
    expect(requestsMigrate(argv(SEED_FLAG))).toBe(false);
    expect(requestsSeed(argv(MIGRATE_FLAG))).toBe(false);
  });

  test("no env var can select a data path — only the flags do", () => {
    const before = process.env.DB;
    process.env.DB = "smoke-twin";
    try {
      // No flag → the remote default, never a mode smuggled in through the env.
      expect(parse(argv()).dataPath.kind).toBe("external");
      expect(parse(argv("--local")).dataPath.kind).toBe("ephemeral");
    } finally {
      if (before === undefined) delete process.env.DB;
      else process.env.DB = before;
    }
  });
});


describe("validateArgv — unknown flags are errors, not silence", () => {
  test("--fixed-ports is rejected (the flag that never existed and booted green)", () => {
    const errors = validateArgv(argv("--smoke", "--fixed-ports"));
    expect(errors).not.toHaveLength(0);
    expect(errors.join(" ")).toMatch(/unknown flag "--fixed-ports"/);
  });

  test("a near-miss flag gets a suggestion", () => {
    expect(validateArgv(argv("--no-tui2")).join(" ")).toMatch(/--no-tui/);
  });

  test("a clean invocation passes", () => {
    expect(validateArgv(argv("--smoke", DB_FLAG, "smoke-twin", "--no-tui"))).toEqual([]);
  });

  test("--migrate is a known bare switch, not an unknown flag", () => {
    expect(validateArgv(argv(DB_FLAG, "external", MIGRATE_FLAG))).toEqual([]);
  });

  test("an arity-1 flag's value is consumed, not read as a positional", () => {
    expect(validateArgv(argv("--pg-data", "/srv/pg"))).toEqual([]);
  });

  test("an arity-1 flag with no value is an error", () => {
    expect(validateArgv(argv("--pg-data")).join(" ")).toMatch(/requires a value/);
  });

  test("a switch given a value is an error", () => {
    expect(validateArgv(argv("--smoke=yes")).join(" ")).toMatch(/takes no value/);
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

  test("the smoke-twin is the case that proves they differ", () => {
    expect(ownsData({ kind: "smoke-twin" })).not.toBe(usesComposePostgres({ kind: "smoke-twin" }));
  });
});

describe("requestsMigrate — a bare switch, argv-only", () => {
  test("true when --migrate is present", () => {
    expect(requestsMigrate(argv(DB_FLAG, "external", MIGRATE_FLAG))).toBe(true);
  });

  test("false when it is absent", () => {
    expect(requestsMigrate(argv(DB_FLAG, "external"))).toBe(false);
  });

  test("false on a bare argv", () => {
    expect(requestsMigrate(argv())).toBe(false);
  });
});

describe("requestsSeed — a bare switch, argv-only", () => {
  test("true when --seed is present", () => {
    expect(requestsSeed(argv(DB_FLAG, "external", SEED_FLAG))).toBe(true);
  });

  test("false when it is absent", () => {
    expect(requestsSeed(argv(DB_FLAG, "external"))).toBe(false);
  });

  test("false on a bare argv", () => {
    expect(requestsSeed(argv())).toBe(false);
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
    for (const s of ["api", "worker-swarm", "worker-analytics", "worker-research"]) {
      expect(yaml).toContain(`  ${s}:\n    depends_on: !reset null`);
    }
  });

  test("the smoke-twin overlay names itself, so a stray file on disk is attributable", () => {
    expect(dataPathOverlayYaml(TWIN)).toContain(`${DB_FLAG} smoke-twin`);
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
  test("ephemeral names the compose volume", () => {
    expect(keptDataDescription({ kind: "ephemeral" }, "p")).toBe("volume p_pgdata");
  });

  test("--pg-data names the bind dir instead", () => {
    expect(keptDataDescription({ kind: "ephemeral" }, "p", "/srv/pg")).toBe("--pg-data dir /srv/pg");
  });

  test("smoke-twin names its OWN volume, never a pgdata it never created", () => {
    expect(keptDataDescription(TWIN, "p")).toBe(`smoke-twin volume ${TWIN.volume}`);
    expect(keptDataDescription(TWIN, "p")).not.toContain("pgdata");
  });

  test("external kept NOTHING — the pre-union bug was claiming otherwise", () => {
    // cleanup() used to name `<project>_pgdata` unconditionally, so an external
    // boot reported keeping a volume it had never created and sent smoke:clean
    // after storage that does not exist.
    expect(keptDataDescription(EXTERNAL, "p")).toBeUndefined();
  });
});
