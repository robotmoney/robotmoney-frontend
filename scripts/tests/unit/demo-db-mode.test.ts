// Unit tests for the `--db` data-path resolver and the argv allowlist
// (scripts/lib/demo-db-mode.ts).
//
// Imported from scripts/demo.ts — the `bun run demo` entrypoint re-exports the
// module and only triggers the side-effectful bring-up under `import.meta.main`,
// so this import is safe and proves the tested resolver is exactly the one the
// demo consumes (same arrangement as demo-env.test.ts and demo-external-pg.test.ts).
//
// Contract under test:
//   - THREE named modes, one flag. Default is ephemeral; no env var can change it.
//   - Every invalid combination is refused AT PARSE TIME, before any restore
//     work — a twin that discovers its own invalidity after a multi-minute
//     pg_restore has already wasted the window it exists to protect.
//   - Unknown flags are ERRORS. They used to be ignored, which booted the
//     default data path while looking like the one that was asked for.
//   - `--external-pg` still works, and says it is deprecated.
//   - ownsData() and usesComposePostgres() are DIFFERENT questions; the twin is
//     the case that proves it.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bannerFor,
  DB_FLAG,
  DB_MODES,
  dataPathOverlayYaml,
  ownsData,
  parseDataPath,
  usesComposePostgres,
  validateArgv,
  type ResolvedDataPath,
} from "../../demo.ts";

/** argv as bun hands it over: [runtime, script, ...flags]. */
const argv = (...flags: string[]): string[] => ["bun", "scripts/demo.ts", ...flags];

function envFileWith(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-db-mode-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents);
  return path;
}

const REAL_ENV = envFileWith("DATABASE_URL=postgres://u:hunter2secret@db.example.com:25060/defaultdb\n");
const NO_ENV = join(tmpdir(), "rm-db-mode-absent", ".env");
const parse = (a: string[], envFilePath = REAL_ENV) => parseDataPath(a, { envFilePath });

describe("default and the three modes", () => {
  test("no flag → ephemeral, and no warning", () => {
    const { dataPath, warnings } = parse(argv());
    expect(dataPath).toEqual({ kind: "ephemeral" });
    expect(warnings).toEqual([]);
  });

  for (const mode of DB_MODES) {
    test(`--db ${mode} parses`, () => {
      const extra = mode === "twin" ? ["--smoke"] : [];
      expect(parse(argv(DB_FLAG, mode, ...extra)).dataPath.kind).toBe(mode);
    });
  }

  test("--db=twin (inline form) parses the same as --db twin", () => {
    expect(parse(argv(`${DB_FLAG}=twin`, "--smoke")).dataPath.kind).toBe("twin");
  });

  test("--db external resolves the address from the .env FILE", () => {
    const dp = parse(argv(DB_FLAG, "external")).dataPath;
    expect(dp).toMatchObject({ kind: "external", host: "db.example.com", source: "DATABASE_URL" });
  });

  test("--db twin carries the backup dir when one is named", () => {
    const dp = parse(argv(DB_FLAG, "twin", "--smoke", "--backup-dir", "/srv/backups")).dataPath;
    expect(dp).toEqual({ kind: "twin", backupDir: "/srv/backups" });
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
    expect(() => parse(argv(DB_FLAG, "twni", "--smoke"))).toThrow(/twin/);
  });

  test("--db twin without --smoke is refused, with the reason", () => {
    expect(() => parse(argv(DB_FLAG, "twin"))).toThrow(/requires --smoke/);
    expect(() => parse(argv(DB_FLAG, "twin"))).toThrow(/POPULATED/);
  });

  test("--db twin + --pg-data is refused", () => {
    expect(() => parse(argv(DB_FLAG, "twin", "--smoke", "--pg-data", "/srv/pg"))).toThrow(
      /mutually exclusive/,
    );
  });

  test("--db external + --pg-data is refused", () => {
    expect(() => parse(argv(DB_FLAG, "external", "--pg-data", "/srv/pg"))).toThrow(
      /mutually exclusive/,
    );
  });

  test("--backup-dir without a twin is refused", () => {
    expect(() => parse(argv("--backup-dir", "/srv/backups"))).toThrow(/only applies/);
  });

  test("--db external with an unreadable .env fails loudly, never falls back", () => {
    expect(() => parse(argv(DB_FLAG, "external"), NO_ENV)).toThrow(/no readable \.env/);
  });

  test("no env var can select a data path", () => {
    const before = process.env.DB;
    process.env.DB = "twin";
    try {
      expect(parse(argv()).dataPath.kind).toBe("ephemeral");
    } finally {
      if (before === undefined) delete process.env.DB;
      else process.env.DB = before;
    }
  });
});

describe("--external-pg — deprecated, still works", () => {
  test("alone → external, plus a DEPRECATED warning", () => {
    const { dataPath, warnings } = parse(argv("--external-pg"));
    expect(dataPath.kind).toBe("external");
    expect(warnings.join(" ")).toMatch(/DEPRECATED/);
    expect(warnings.join(" ")).toMatch(/--db external/);
  });

  test("paired with the equivalent --db external: allowed, one warning", () => {
    const { dataPath, warnings } = parse(argv("--external-pg", DB_FLAG, "external"));
    expect(dataPath.kind).toBe("external");
    expect(warnings).toHaveLength(1);
  });

  test("paired with a CONFLICTING mode: refused", () => {
    expect(() => parse(argv("--external-pg", DB_FLAG, "twin", "--smoke"))).toThrow(
      /different data paths/,
    );
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
    expect(validateArgv(argv("--smoke", DB_FLAG, "twin", "--no-tui"))).toEqual([]);
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
    ["twin", true, false],
  ] as const)("%s: ownsData=%s usesComposePostgres=%s", (kind, owns, compose) => {
    expect(ownsData({ kind })).toBe(owns);
    expect(usesComposePostgres({ kind })).toBe(compose);
  });

  test("the twin is the case that proves they differ", () => {
    expect(ownsData({ kind: "twin" })).not.toBe(usesComposePostgres({ kind: "twin" }));
  });
});

const TWIN: ResolvedDataPath = {
  kind: "twin",
  url: "postgres://restore_check:rk_secretpass@172.17.0.1:49155/rm_restore_check",
  redactedUrl: "postgres://restore_check:***@172.17.0.1:49155/rm_restore_check",
  container: "rm-restore-20260821T101500Z-a3f9c1",
  volume: "rm_demo_twindata",
  stamp: "20260821T101500Z",
};
const EXTERNAL: ResolvedDataPath = {
  kind: "external",
  url: "postgres://u:hunter2secret@db.example.com:25060/defaultdb",
  redactedUrl: "postgres://u:***@db.example.com:25060/defaultdb",
  host: "db.example.com",
  source: "DATABASE_URL",
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

  test("the twin overlay names itself, so a stray file on disk is attributable", () => {
    expect(dataPathOverlayYaml(TWIN)).toContain(`${DB_FLAG} twin`);
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

  test("twin says the copy OUTLIVES the boot and names the reclaim command", () => {
    const b = bannerFor(TWIN);
    expect(b).toMatch(/OUTLIVES THIS BOOT/);
    expect(b).toMatch(/demo:clean/);
    expect(b).toMatch(/credential material/);
  });

  test("twin does not borrow external's wording — the two are opposites", () => {
    expect(bannerFor(TWIN)).not.toMatch(/SOMEONE ELSE'S/);
  });

  test("no banner leaks a password", () => {
    expect(bannerFor(TWIN)).not.toContain("rk_secretpass");
    expect(bannerFor(EXTERNAL)).not.toContain("hunter2secret");
  });
});
