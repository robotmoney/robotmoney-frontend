// Single orchestrator for every one-time production data-bootstrap pipeline
// this repo has. Runs each pipeline IN PROCESS (imports + calls the exported
// function directly — never shells out to another `bun run` script), in
// dependency order, and renders live per-step status with plain ANSI escape
// codes (no new terminal-UI dependency).
//
// Steps (fixed, not a generic pluggable framework — there are exactly three):
//   1. migrations           — src/db/migrate.ts's migrate(). MUST run first:
//                              the v0 seed step depends on migration 0026
//                              (swarm_sessions.legacy_takes) having been
//                              applied.
//   2. v0-seed:bootstrap    — scripts/v0-seed-bootstrap.ts's
//                              runV0SeedBootstrap(). Direct-SQL, returns a
//                              structured V0BootstrapResult (members/subjects/
//                              sessions counts + drifts[]).
//   3. edgar-seed:bootstrap — src/analytics/edgar-seed-loader.ts's
//                              bootstrapEdgarSeed(). Goes through the live
//                              authenticated analytics HTTP API, NOT direct
//                              SQL. Degrades to SKIPPED (never FAILED) when
//                              ANALYTICS_TOKEN is unset or the API is
//                              unreachable — that is the expected shape of a
//                              DB-only bootstrap context (e.g. a migration
//                              job with no api process running).
//
// Every step is attempted even if an earlier one failed (no fail-fast) — same
// "attempt everything, decide the outcome at the end" principle
// runV0SeedBootstrap() itself already follows for its own three entity kinds.
// The final exit code is non-zero only if a step actually FAILED — decided
// after every step has run. v0-seed DRIFT is deliberately NOT failing here:
// this orchestrator is the boot path, and a boot may be adopting a working
// production database (manually restored from a .dump, or a local postgres
// volume that survived a restart) whose rows legitimately differ from the
// archive. Existing rows win, the drift is printed field-by-field, the boot
// proceeds. The standalone `bun run v0-seed:bootstrap` keeps its own strict
// exit-nonzero-on-drift convention — THAT invocation is an explicit integrity
// check, this one is initialization.
//
// Usage: DATABASE_URL=... [ANALYTICS_API_URL=... ANALYTICS_TOKEN=...] \
//   bun run scripts/prod-bootstrap.ts
// (wired as `bun run prod-bootstrap` in package.json)
import { migrate } from "../src/db/migrate.ts";
import { sql, closeDb } from "../src/db/client.ts";
import { runV0SeedBootstrap } from "./v0-seed-bootstrap.ts";
import { bootstrapEdgarSeed } from "../src/analytics/edgar-seed-loader.ts";
import { resolveAnalyticsApiConfig } from "../src/analytics/api-client.ts";
import { envSecret } from "../src/lib/env-secret.ts";

type StepStatus = "success" | "failed" | "warning" | "skipped";

interface StepResult {
  status: StepStatus;
  summary: string;
  // Set when a step should contribute to a non-zero overall exit code even
  // though its own status glyph isn't "failed". No step sets it today —
  // v0-seed drift used to, before adopted-production databases made drift an
  // expected report — but the aggregation stays: it is the seam that lets a
  // future step distinguish "warn the operator" from "fail the boot".
  failing?: boolean;
}

interface Step {
  name: string;
  run: () => Promise<StepResult>;
}

// ── Step 1: migrations ──────────────────────────────────────────────────────

async function getAppliedMigrations(): Promise<Set<string>> {
  try {
    const rows = await sql<{ name: string }[]>`SELECT name FROM schema_migrations`;
    return new Set(rows.map((r) => r.name));
  } catch {
    // schema_migrations doesn't exist yet on a brand-new database.
    return new Set();
  }
}

async function runMigrationsStep(): Promise<StepResult> {
  const before = await getAppliedMigrations();
  await migrate();
  const after = await getAppliedMigrations();
  const newly = [...after].filter((n) => !before.has(n));
  return {
    status: "success",
    summary: `${newly.length} new migration(s) applied (${after.size} total)`,
  };
}

// ── Step 2: v0-seed:bootstrap ────────────────────────────────────────────────

async function runV0SeedStep(): Promise<StepResult> {
  const result = await runV0SeedBootstrap();
  // Every dataset the archive carries is named, so an operator reading this
  // one line can tell that takes/snapshots/briefs actually loaded rather than
  // inferring it from a session count.
  const summary =
    `${result.members.inserted} members, ${result.subjects.inserted} subjects, ` +
    `${result.sessions.inserted} sessions, ${result.takes.inserted} takes, ` +
    `${result.snapshots.inserted} snapshots, ${result.briefs.inserted} briefs inserted, ` +
    `${result.drifts.length} drift`;
  if (result.drifts.length > 0) {
    // Warning glyph, NOT failing: on an adopted production database the
    // existing rows are the record and the archive is only the gap-filler, so
    // "existing differs from archive" is a fact to report, not an error to
    // abort on. runV0SeedBootstrap() has already printed every drifted field
    // (old vs incoming) and left the existing rows untouched.
    return { status: "warning", summary };
  }
  return { status: "success", summary };
}

// ── Step 3: edgar-seed:bootstrap ─────────────────────────────────────────────

const EDGAR_STEP_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Codes for "expected, degrade-gracefully" failure modes: connection refused,
// DNS failure, host unreachable, connection reset. Node's fetch/undici surfaces
// these on `err.cause.code`; Bun's own fetch implementation surfaces its own
// string code (e.g. "ConnectionRefused") directly on the error object instead
// — both shapes are checked so this holds under either runtime.
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "ConnectionRefused",
]);

function errorCode(err: Error): string | undefined {
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (err as { cause?: { code?: unknown } }).cause;
  if (typeof cause?.code === "string") return cause.code;
  return undefined;
}

// Classifies "expected, degrade-gracefully" failure modes (connection
// refused, DNS failure, connect timeout, our own timeout race above) as
// distinct from a genuine failure (e.g. HTTP 401/500 from a reachable API).
function isUnreachable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message.includes("timed out after")) return true;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  if (err.message.toLowerCase().includes("fetch failed")) return true;
  if (err.message.toLowerCase().includes("unable to connect")) return true;
  const code = errorCode(err);
  if (code && UNREACHABLE_CODES.has(code)) return true;
  return false;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = errorCode(err);
    if (code) return code;
    return err.message;
  }
  return String(err);
}

async function runEdgarSeedStep(): Promise<StepResult> {
  const token = envSecret("ANALYTICS_TOKEN");
  if (!token) {
    return { status: "skipped", summary: "skipped: ANALYTICS_TOKEN not set" };
  }

  const cfg = resolveAnalyticsApiConfig();
  try {
    const result = await withTimeout(
      bootstrapEdgarSeed(cfg),
      EDGAR_STEP_TIMEOUT_MS,
      `edgar-seed:bootstrap (${cfg.baseUrl})`,
    );
    return {
      status: "success",
      summary: `seeded=${result.seededPoints} existing=${result.existingPoints} indicators=${result.indicators}`,
    };
  } catch (err) {
    if (isUnreachable(err)) {
      return { status: "skipped", summary: `skipped: ${cfg.baseUrl} unreachable (${describeError(err)})` };
    }
    throw err; // genuine failure (auth/server error on a reachable API) — let the caller mark it FAILED.
  }
}

// ── Fixed step list ──────────────────────────────────────────────────────────

const initializationSteps: Step[] = [
  { name: "v0-seed:bootstrap", run: runV0SeedStep },
  { name: "edgar-seed:bootstrap", run: runEdgarSeedStep },
];

export interface ProdBootstrapOptions {
  /** The caller already ran migrate() in its stack lifecycle. */
  alreadyMigrated?: boolean;
}

function stepsFor(options: ProdBootstrapOptions): Step[] {
  return options.alreadyMigrated
    ? [...initializationSteps]
    : [{ name: "migrations", run: runMigrationsStep }, ...initializationSteps];
}

// ── Status rendering (plain ANSI, no new dependency) ────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GLYPH: Record<StepStatus, string> = {
  success: "\x1b[32m✓\x1b[0m",
  failed: "\x1b[31m✗\x1b[0m",
  warning: "\x1b[33m⚠\x1b[0m",
  skipped: "\x1b[90m⊘\x1b[0m",
};
const PLAIN_GLYPH: Record<StepStatus, string> = {
  success: "OK",
  failed: "FAIL",
  warning: "WARN",
  skipped: "SKIP",
};

function fmtElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export interface StepReport {
  name: string;
  status: StepStatus;
  elapsedMs: number;
  summary: string;
  failing: boolean;
}

async function runStepWithStatus(step: Step, index: number, total: number): Promise<StepReport> {
  const label = `[${index}/${total}] ${step.name}`;
  const start = Date.now();
  const isTTY = Boolean(process.stdout.isTTY);
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  if (isTTY) {
    process.stdout.write(`\x1b[2K\r${SPINNER_FRAMES[0]} ${label}`);
    timer = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      const elapsed = fmtElapsed(Date.now() - start);
      process.stdout.write(`\x1b[2K\r${SPINNER_FRAMES[frame]} ${label} (${elapsed})`);
    }, 80);
  } else {
    process.stdout.write(`${label} ... `);
  }

  let status: StepStatus;
  let summary: string;
  let failing = false;
  try {
    const result = await step.run();
    status = result.status;
    summary = result.summary;
    failing = result.failing ?? false;
  } catch (err) {
    status = "failed";
    summary = err instanceof Error ? err.message : String(err);
    failing = true;
  }

  if (timer) clearInterval(timer);
  const elapsedMs = Date.now() - start;
  const glyph = isTTY ? GLYPH[status] : PLAIN_GLYPH[status];
  if (isTTY) process.stdout.write(`\x1b[2K\r`);
  process.stdout.write(`${glyph} ${label} — ${fmtElapsed(elapsedMs)} — ${summary}\n`);

  return { name: step.name, status, elapsedMs, summary, failing: failing || status === "failed" };
}

const PLAIN_GLYPH_WIDTH = Math.max(...Object.values(PLAIN_GLYPH).map((g) => g.length));

function printSummaryTable(reports: StepReport[]): void {
  const isTTY = Boolean(process.stdout.isTTY);
  // Colored glyphs are always a single visual character; plain-text glyphs
  // (OK/FAIL/WARN/SKIP) vary in length, so pad only those to keep the
  // non-TTY table's columns aligned.
  const glyphOf = (s: StepStatus) => (isTTY ? GLYPH[s] : PLAIN_GLYPH[s].padEnd(PLAIN_GLYPH_WIDTH));
  const nameWidth = Math.max(4, ...reports.map((r) => r.name.length));
  const timeWidth = Math.max(4, ...reports.map((r) => fmtElapsed(r.elapsedMs).length));

  console.log("\nSummary");
  console.log("-------");
  for (const r of reports) {
    const name = r.name.padEnd(nameWidth);
    const time = fmtElapsed(r.elapsedMs).padStart(timeWidth);
    console.log(`${glyphOf(r.status)}  ${name}  ${time}  ${r.summary}`);
  }
}

// ── Entrypoint ───────────────────────────────────────────────────────────────

// The core, testable orchestration: runs every step (always to completion —
// no fail-fast) and returns each one's structured report. No process.exitCode
// side effect, so a caller (test or CLI) decides what to do with the outcome
// — same separation as v0-seed-bootstrap.ts's runV0SeedBootstrap()/main().
export async function runProdBootstrap(options: ProdBootstrapOptions = {}): Promise<StepReport[]> {
  console.log("robotmoney prod-bootstrap — one-time production data pipelines\n");

  const steps = stepsFor(options);
  const reports: StepReport[] = [];
  for (let i = 0; i < steps.length; i++) {
    reports.push(await runStepWithStatus(steps[i]!, i + 1, steps.length));
  }

  printSummaryTable(reports);
  return reports;
}

/** Archive/EDGAR initialization for a Stack.up() that already migrated once. */
export async function runAlreadyMigratedProdInitialization(): Promise<StepReport[]> {
  return runProdBootstrap({ alreadyMigrated: true });
}

export async function main(): Promise<void> {
  const known = new Set(["--already-migrated"]);
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Error(`prod-bootstrap: unknown argument(s): ${unknown.join(", ")}`);
  const reports = await runProdBootstrap({ alreadyMigrated: args.includes("--already-migrated") });
  if (reports.some((r) => r.failing)) {
    process.exitCode = 1;
  }
}

// Run directly: `bun run scripts/prod-bootstrap.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(closeDb)
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
      return closeDb();
    });
}
