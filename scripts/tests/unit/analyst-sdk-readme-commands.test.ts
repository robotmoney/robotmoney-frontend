// Issue 1404: the analyst SDK README's quickstart is executed, not just linted,
// in an export of the package's tracked files.
//   - The `<!-- readme-test: acquire -->` blocks (the API-only fill, and the
//     repo-plus-increment fill) run as one bash script against a local fake
//     public API that serves the committed recording of the REAL archive routes
//     (tests/fixtures/archive/api-recorded/, kept equal to the routes by
//     backend/tests/analyst-sdk-public-archive-recording.test.ts).
//   - Then the fake API is shut down, `API` points at a closed port, and every
//     `<!-- readme-test: run -->` line runs as written with a preload that
//     records and refuses any fetch: no stage after acquisition may make an
//     HTTP request, and the API sees no further request.
// Then the generated inputs and reports are checked, the two fills compared,
// and the explicit errors for missing or wrong inputs.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportPackage, sh } from "./support/analyst-sdk-export.ts";

setDefaultTimeout(180_000);
const root = join(import.meta.dir, "../../..");
const README = readFileSync(join(root, "packages/analyst-sdk/README.md"), "utf8");

/** The text of every block with this marker, in order. */
export function readmeBlocks(text: string, marker: "run" | "acquire"): string[] {
  const re = new RegExp(`<!-- readme-test: ${marker} -->\\s*\\n\`\`\`sh\\n([\\s\\S]*?)\`\`\``, "g");
  return [...text.matchAll(re)].map((m) => m[1]!);
}

/** The command lines of every block marked to run, in order. */
export function readmeCommands(text: string): string[] {
  const out: string[] = [];
  const re = /<!-- readme-test: run -->\s*\n```sh\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    for (const line of m[1]!.split("\n")) {
      const cmd = line.replace(/\s+#.*$/, "").trim();
      if (cmd) out.push(cmd);
    }
  }
  return out;
}

const DIR = exportPackage("rm-sdk-readme-");
afterAll(() => rmSync(DIR, { recursive: true, force: true }));
const ATTEMPTS = join(DIR, "network-attempts.log");
// Every `bun` process started in DIR loads this first (top-level bunfig preload).
writeFileSync(
  join(DIR, "tests/readme-no-network.ts"),
  `import { appendFileSync } from "node:fs";
globalThis.fetch = ((input: unknown) => {
  appendFileSync(${JSON.stringify(ATTEMPTS)}, String(input) + "\\n");
  throw new Error("README commands must not use the network after acquisition");
}) as unknown as typeof fetch;
`,
);
writeFileSync(join(DIR, "bunfig.toml"), `preload = ["./tests/readme-no-network.ts"]\n` + readFileSync(join(DIR, "bunfig.toml"), "utf8"));

const RECORDING = join(DIR, "tests/fixtures/archive/api-recorded");
const served: string[] = [];
const fake = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    served.push(path);
    const prefix = "/api/public/analytics/archive/";
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    const rel = path.slice(prefix.length);
    const file = rel === "backups" ? join(RECORDING, "backups.json") : join(RECORDING, rel);
    if (rel.includes("..") || !existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(readFileSync(file), { headers: { "Content-Type": rel.endsWith(".gz") ? "application/gzip" : "application/json" } });
  },
});
afterAll(() => fake.stop(true));

describe("README quickstart, executed", () => {
  const commands = readmeCommands(README);
  const acquire = readmeBlocks(README, "acquire");
  const results: { cmd: string; code: number; stdout: string; stderr: string }[] = [];
  let acquired = 0;

  test("the README marks the acquisition and quickstart blocks (red control: the extractor finds them)", () => {
    expect(acquire.length).toBe(2);
    expect(acquire[0]).toContain("archive/backups");
    expect(commands.length).toBeGreaterThanOrEqual(7);
    expect(commands.some((c) => c.startsWith("bun run inputs"))).toBe(true);
    expect(commands.some((c) => c.includes("--provenance"))).toBe(true);
    expect(readmeCommands("```sh\nbun run regime x\n```")).toEqual([]);
  });

  test("acquisition: the API-only fill and the repo-plus-increment fill, against the recorded real routes", async () => {
    for (const tool of ["curl", "jq", "sha256sum", "bash"]) {
      expect(Bun.which(tool), `${tool} is required by the README's fill`).not.toBeNull();
    }
    const i = await sh(["bun", "install", "--frozen-lockfile", "--production"], DIR);
    expect(i.code, i.stderr).toBe(0);
    const api = `http://127.0.0.1:${fake.port}/api/public/analytics`;
    const r = await sh(["bash", "-euo", "pipefail", "-c", acquire.join("\n")], DIR, { API: api });
    expect(r.code, r.stderr).toBe(0);
    acquired = served.length;
    const files = (dir: string) => Bun.spawnSync(["find", dir, "-type", "f"], { cwd: DIR }).stdout.toString().trim().split("\n").map((f) => f.slice(dir.length + 1)).sort();
    const recorded = files(RECORDING.slice(DIR.length + 1)).filter((f) => f !== "backups.json");
    expect(files("api-copy")).toEqual(recorded);
    expect(files("repo-copy")).toEqual(recorded);
    // The increment fetched only the backup the stand-in clone lacked.
    const fetchedData = served.filter((p) => p.includes("/data/"));
    expect(fetchedData.filter((p) => p.includes("2001-01-02T000000Z")).length).toBe(recorded.filter((f) => f.startsWith("csv/2001-01-02T000000Z/data/")).length);
    for (const f of recorded) expect(readFileSync(join(DIR, "api-copy", f)).equals(readFileSync(join(RECORDING, f)))).toBe(true);
  });

  test("acquisition refuses an archive that inflates past its record's bytes_raw", async () => {
    // Plant a record whose archive is the real one but whose bytes_raw is one byte short.
    const rec = readdirSync(join(RECORDING, "csv")).sort()[0]!;
    const recPath = `csv/${rec}/backup.json`;
    const record = JSON.parse(readFileSync(join(RECORDING, recPath), "utf8"));
    const f = Object.values(record.append_only as Record<string, { files: { path: string; bytes_raw: number }[] }>).flatMap((t) => t.files)[0]!;
    f.bytes_raw -= 1;
    const bad = join(DIR, "bad-recording");
    mkdirSync(join(bad, "csv", rec), { recursive: true });
    writeFileSync(join(bad, recPath), JSON.stringify(record));
    mkdirSync(join(bad, f.path, ".."), { recursive: true });
    writeFileSync(join(bad, f.path), readFileSync(join(RECORDING, f.path)));
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        const rel = new URL(req.url).pathname.slice("/api/public/analytics/archive/".length);
        const file = rel === "backups" ? undefined : join(bad, rel);
        if (rel === "backups") return Response.json({ backups: [{ record: recPath }] });
        return file && existsSync(file) ? new Response(readFileSync(file)) : new Response("not found", { status: 404 });
      },
    });
    try {
      const fill = acquire[0]!.replace(/^fill api-copy$/m, "fill bad-copy");
      const r = await sh(["bash", "-euo", "pipefail", "-c", fill], DIR, { API: `http://127.0.0.1:${srv.port}/api/public/analytics` });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(`corrupt: ${f.path}`);
      expect(existsSync(join(DIR, "bad-copy", recPath))).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("every later command runs as written and exits 0, with no HTTP request", async () => {
    expect(acquired).toBeGreaterThan(0);
    fake.stop(true);
    for (const cmd of commands) {
      const r = await sh(["bash", "-c", cmd], DIR, { API: "http://127.0.0.1:9/api/public/analytics" });
      results.push({ cmd, ...r });
      expect(r.code, `${cmd}\n${r.stderr}`).toBe(0);
    }
    expect(existsSync(ATTEMPTS)).toBe(false);
    expect(served.length).toBe(acquired);
  });

  test("the commands produced the documented inputs and reports; both fills give the same input", () => {
    const run = "0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5ea2";
    for (const fill of ["api-fill", "repo-fill"]) {
      expect(readFileSync(join(DIR, fill, "inputs.csv"), "utf8").split("\n")[0]).toBe("date,series,value,kind");
      const m = JSON.parse(readFileSync(join(DIR, fill, "inputs.manifest.json"), "utf8"));
      expect(m).toMatchObject({ run_key: run, backup_id: "2001-01-03T000000Z", asof: "2026-08-15", source: "api" });
    }
    expect(readFileSync(join(DIR, "api-fill/inputs.csv")).equals(readFileSync(join(DIR, "repo-fill/inputs.csv")))).toBe(true);
    const out = (cmd: string) => results.find((r) => r.cmd === cmd)!;
    const report = JSON.parse(out("bun run regime api-fill/inputs.csv --replay --asof 2026-08-15").stdout);
    expect(report.asof).toBe("2026-08-15");
    expect(report.backtest).not.toBeNull();
    const env = JSON.parse(out("bun run regime api-fill/inputs.csv --replay --asof 2026-08-15 --provenance").stdout);
    expect(env.pinned).toBe(true);
    expect(env.manifest.run_key).toBe(run);
    expect(JSON.stringify(env.report)).toBe(JSON.stringify(report));
    expect(JSON.parse(out("bun run regime tests/fixtures/raw-indicator-history.csv --provenance").stdout).pinned).toBe(false);
  });

  test("missing or wrong inputs fail explicitly, with no acquisition attempt", async () => {
    const [noReplay, noFile, noRun, noArchive] = await Promise.all([
      sh(["bun", "run", "regime", "api-fill/inputs.csv"], DIR),
      sh(["bun", "run", "regime", "no-such-input.csv"], DIR),
      sh(["bun", "run", "inputs", "--archive", "api-copy", "--run", "00000000-0000-4000-8000-000000000000", "--out", "x"], DIR),
      sh(["bun", "run", "inputs", "--archive", "no-such-copy", "--run", "0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5ea2", "--out", "y"], DIR),
    ]);
    expect(noReplay.code).toBe(1);
    expect(noReplay.stderr).toMatch(/ReplayContractError/);
    expect(noFile.code).toBe(1);
    expect(noFile.stderr).toMatch(/no-such-input\.csv/);
    expect(noRun.code).toBe(1);
    expect(noRun.stderr).toMatch(/not in the local copy's run ledger/);
    expect(noArchive.code).toBe(1);
    expect(noArchive.stderr).toMatch(/is not a format 1 local copy/);
    expect(existsSync(ATTEMPTS)).toBe(false);
    expect(served.length).toBe(acquired);
  });
});
