// The command line as a process (issue 1404; analyst SDK requirements section
// 6): the golden bytes, strict arguments, caller-directory paths through both
// direct Bun and `bun run`, and the provenance envelope. Every case spawns the
// real bin/regime.ts or bin/inputs.ts.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

setDefaultTimeout(180_000);
const DIR = import.meta.dir;
const PKG = join(DIR, "..");
const REGIME = join(PKG, "bin/regime.ts");
const INPUTS = join(PKG, "bin/inputs.ts");
const FIXTURE = join(DIR, "fixtures/raw-indicator-history.csv");
const GOLDEN = readFileSync(join(DIR, "golden/regime-report.json"), "utf8");
const FACTS = JSON.parse(readFileSync(join(DIR, "fixtures/archive/facts.json"), "utf8"));
const [RUN1, RUN2] = Object.keys(FACTS.runs) as [string, string];

// A scratch folder inside the package, so `bun run` (which needs the package's
// package.json above it) can be started from a folder that is not the root.
const TMP = mkdtempSync(join(DIR, ".cli-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

type Out = { code: number; stdout: string; stderr: string };
async function run(cmd: string[], cwd: string): Promise<Out> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}
const regime = (args: string[], cwd = PKG) => run(["bun", REGIME, ...args], cwd);

// A small source input whose last date identifies it.
function probe(dir: string, name: string, lastDay: number): string {
  const lines = ["date,series,value"];
  for (let i = 0; i < lastDay; i++) lines.push(`${new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10)},VIX,${12 + (i % 5)}`);
  const p = join(dir, name);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

describe("golden and determinism", () => {
  test("the CLI, run as a process, prints the golden report byte for byte, twice", async () => {
    const [a, b] = await Promise.all([regime([FIXTURE]), regime(["tests/fixtures/raw-indicator-history.json"])]);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(GOLDEN);
    expect(b.stdout).toBe(GOLDEN);
    const c = await run(["bun", "run", "regime", "tests/fixtures/raw-indicator-history.csv"], PKG);
    expect(c.code).toBe(0);
    expect(c.stdout).toBe(GOLDEN);
  });
});

describe("arguments", () => {
  const P = probe(TMP, "args.csv", 30);
  const cases: [string[], RegExp][] = [
    [[P, P], /unexpected extra argument/],
    [[P, "other.csv"], /unexpected extra argument/],
    [[P, "--asof", "2024-01-05", "--asof", "2024-01-06"], /--asof given more than once/],
    [[P, "--full", "--full"], /--full given more than once/],
    [[P, "--bogus"], /unknown option --bogus/],
    [[P, "--panels", "macro"], /--panels was replaced by --factor/],
    [[P, "--asof"], /--asof needs a value/],
    [[P, "--start", "--full"], /--start needs a value/],
    [[P, "--asof", "banana"], /asof must be a real date/],
    [[P, "--start", "2030-01-01"], /after every input row/],
    [[], /an input file is required/],
  ];
  test("bad arguments exit 2 with a message on stderr and nothing on stdout", async () => {
    const outs = await Promise.all(cases.map(([a]) => regime(a, TMP)));
    outs.forEach((o, i) => {
      expect(o.code, `case ${i}: ${cases[i]![0].join(" ")}`).toBe(2);
      expect(o.stderr).toMatch(cases[i]![1]);
      expect(o.stderr).toContain("usage: bun run regime");
      expect(o.stdout).toBe("");
    });
  });

  test("runtime failures exit 1: a missing file, a malformed input, no series the run reads", async () => {
    const bad = join(TMP, "bad.csv");
    writeFileSync(bad, "date,series,value\n2024-02-30,VIX,1\n");
    const foo = join(TMP, "foo.csv");
    writeFileSync(foo, "date,series,value\n2024-01-01,FOO,1\n");
    const [missing, malformed, unread] = await Promise.all([regime(["no-such-file.csv"], TMP), regime([bad]), regime([foo])]);
    expect(missing.code).toBe(1);
    expect(malformed.code).toBe(1);
    expect(malformed.stderr).toMatch(/InputRowError: input row 2: date must be a real calendar date/);
    expect(unread.code).not.toBe(0);
    expect(unread.stderr).toMatch(/no series the run reads/);
  });
});

describe("relative paths resolve from the caller's folder", () => {
  const sub = mkdtempSync(join(TMP, "caller-"));
  probe(sub, "probe.csv", 45); // 2024-02-14
  probe(TMP, "probe.csv", 40); // a different file with the same name one folder up

  test("direct Bun, from two different folders", async () => {
    const [a, b] = await Promise.all([regime(["probe.csv"], sub), regime(["probe.csv"], TMP)]);
    expect(a.code).toBe(0);
    expect(JSON.parse(a.stdout).asof).toBe("2024-02-14");
    expect(JSON.parse(b.stdout).asof).toBe("2024-02-09");
  });

  test("bun run, from two different folders below the package", async () => {
    const [a, b] = await Promise.all([run(["bun", "run", "regime", "probe.csv"], sub), run(["bun", "run", "regime", "probe.csv"], TMP)]);
    expect(a.code, a.stderr).toBe(0);
    expect(JSON.parse(a.stdout).asof).toBe("2024-02-14");
    expect(JSON.parse(b.stdout).asof).toBe("2024-02-09");
    const c = await run(["bun", "run", "regime", "../probe.csv"], sub);
    expect(JSON.parse(c.stdout).asof).toBe("2024-02-09");
  });
});

describe("provenance envelope", () => {
  const out = mkdtempSync(join(TMP, "inputs-"));

  test("an input without a manifest: default output unchanged, the envelope says pinned: false", async () => {
    const [plain, env] = await Promise.all([regime([FIXTURE]), regime([FIXTURE, "--provenance"])]);
    expect(plain.stdout).toBe(GOLDEN);
    const e = JSON.parse(env.stdout);
    expect(Object.keys(e)).toEqual(["pinned", "report"]);
    expect(e.pinned).toBe(false);
    expect(JSON.stringify(e.report, null, 2) + "\n").toBe(GOLDEN);
  });

  test("a generated input: the envelope carries the exact manifest and the unchanged report", async () => {
    const gen = await run(["bun", INPUTS, "--archive", "tests/fixtures/archive/api-only", "--run", RUN2, "--out", out], PKG);
    expect(gen.code, gen.stderr).toBe(0);
    const input = join(out, "inputs.csv");
    const bytes = readFileSync(input);
    const [plain, env] = await Promise.all([regime([input, "--replay"]), regime([input, "--replay", "--provenance"])]);
    expect(plain.code, plain.stderr).toBe(0);
    const e = JSON.parse(env.stdout);
    expect(Object.keys(e)).toEqual(["pinned", "manifest", "report"]);
    expect(e.pinned).toBe(true);
    expect(e.manifest).toEqual({
      format: 1,
      input: "inputs.csv",
      backup_id: FACTS.backup,
      run_key: RUN2,
      asof: FACTS.runs[RUN2].asof,
      source: "api",
      row_count: bytes.toString("utf8").trimEnd().split("\n").length - 1,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      methodology: { id: "3", label: "regime-v3", config_digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
      code_revision: FACTS.build,
    });
    expect(JSON.stringify(e.report, null, 2) + "\n").toBe(plain.stdout);
    // Without --provenance a manifest beside the input changes nothing.
    expect(plain.stdout.startsWith('{\n  "version"')).toBe(true);
  });

  test("a manifest that does not match its input is an error, never pinned: false", async () => {
    const dir = mkdtempSync(join(TMP, "tamper-"));
    const gen = await run(["bun", INPUTS, "--archive", "tests/fixtures/archive/api-only", "--run", RUN1, "--out", dir], PKG);
    expect(gen.code, gen.stderr).toBe(0);
    const m = JSON.parse(readFileSync(join(dir, "inputs.manifest.json"), "utf8"));
    const input = readFileSync(join(dir, "inputs.csv"), "utf8");
    const variants: [string, Record<string, unknown>, string, RegExp][] = [
      ["hash", { ...m, sha256: "0".repeat(64) }, input, /sha256 .* does not match/],
      ["count", { ...m, row_count: m.row_count + 1 }, input, /rows, the manifest says/],
      ["name", { ...m, input: "other.csv" }, input, /manifest describes "other.csv"/],
      ["key", { ...m, extra: 1 }, input, /unknown \[extra\]/],
      ["source", { ...m, source: "web" }, input, /source must be/],
      ["backup", { ...m, backup_id: "latest" }, input, /backup_id must be/],
      ["edited input", m, input.replace(/\n$/, "\n2026-08-01,VIX,99,source\n"), /does not match|rows, the manifest says/],
    ];
    const outs = await Promise.all(
      variants.map(async ([name, man, text]) => {
        const d = mkdtempSync(join(TMP, `t-${name.replace(/ /g, "-")}-`));
        writeFileSync(join(d, "inputs.csv"), text);
        writeFileSync(join(d, "inputs.manifest.json"), JSON.stringify(man));
        return regime([join(d, "inputs.csv"), "--replay", "--provenance"]);
      }),
    );
    outs.forEach((o, i) => {
      expect(o.code, variants[i]![0]).toBe(1);
      expect(o.stderr).toMatch(/ManifestError/);
      expect(o.stderr).toMatch(variants[i]![3]);
      expect(o.stdout).toBe("");
    });
  });
});

describe("bun run inputs", () => {
  test("bad arguments exit 2", async () => {
    const outs = await Promise.all([
      run(["bun", INPUTS], PKG),
      run(["bun", INPUTS, "--archive", "x"], PKG),
      run(["bun", INPUTS, "--archive", "x", "--run", RUN1, "--run", RUN2], PKG),
      run(["bun", INPUTS, "--archive", "x", "--run", RUN1, "stray"], PKG),
      run(["bun", INPUTS, "--archive", "x", "--run", RUN1, "--bogus"], PKG),
    ]);
    for (const o of outs) {
      expect(o.code).toBe(2);
      expect(o.stderr).toContain("usage: bun run inputs");
    }
  });

  test("relative --archive and --out resolve from the caller's folder under bun run; outputs are never overwritten", async () => {
    const sub = mkdtempSync(join(TMP, "gen-"));
    const rel = "../../fixtures/archive/repo-plus-increment";
    const a = await run(["bun", "run", "inputs", "--archive", rel, "--run", RUN2, "--out", "here", "--json"], sub);
    expect(a.code, a.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(sub, "here/inputs.manifest.json"), "utf8")).input).toBe("inputs.json");
    const again = await run(["bun", "run", "inputs", "--archive", rel, "--run", RUN2, "--out", "here", "--json"], sub);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/never overwritten/);
  });
});
