// Service credentials for backend tests, issued the only way the API accepts
// them: a row in the automation-token store (smoke-production-spec.md §3,
// D52 (1)). There is no env token to set and no insecure mode to lean on, so a
// test that calls a privileged route provisions the holder that route admits
// and presents that holder's bearer, exactly as the real caller would.
//
// Each call provisions a fresh instance, so two tests (or two files sharing
// the unmigrated default database) never rotate each other's token.
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "../../src/db/client.ts";
import { HOLDER_RIGHTS, provisionAutomationToken, type AutomationHolder } from "../../src/db/automation-tokens.ts";

let issued = 0;

/**
 * Provision `holder` with its full rights list on a test instance of its own
 * and return the bearer. `rights` narrows the list (a scheduler token that may
 * only read, say); it can never widen it — the store module refuses a right
 * outside the holder's list.
 */
export async function provisionHolderToken(
  holder: AutomationHolder,
  rights: readonly (typeof HOLDER_RIGHTS)[AutomationHolder][number][] = HOLDER_RIGHTS[holder],
): Promise<string> {
  const instance = `rm_test_${holder.replace(/-/g, "_")}_${process.pid}_${++issued}`;
  const { token } = await provisionAutomationToken(instance, [...rights], { holder });
  return token;
}

/** The operator's admin token (right `admin`). */
export const provisionOperatorToken = () => provisionHolderToken("operator");
/** analytics-producer's token (right `analytics_ingestion`). */
export const provisionAnalyticsToken = () => provisionHolderToken("analytics-producer");
/** system-scheduler's token (read_subjects, read_sessions, lifecycle_transitions). */
export const provisionSchedulerToken = () => provisionHolderToken("system-scheduler");

/**
 * Write `token` to a fresh file and return its path — the delivery shape a
 * holder reads (ANALYTICS_TOKEN_FILE, SCHEDULER_TOKEN_FILE; smoke spec §3: "a
 * file the boot places in the instance's state directory").
 */
export function writeTokenFile(token: string, name = "service.token"): string {
  const file = join(mkdtempSync(join(tmpdir(), "rm-test-token-")), name);
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return file;
}

/** Headers each holder presents in production. */
export const adminHeaders = (token: string): Record<string, string> => ({ "X-Admin-Token": token });
export const bearerHeaders = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
export const schedulerHeaders = (token: string): Record<string, string> => ({ "X-Automation-Token": token });
/** One string in every header any credential is read from — the widest presentation. */
export const everyHeader = (token: string): Record<string, string> => ({
  ...adminHeaders(token),
  ...bearerHeaders(token),
  ...schedulerHeaders(token),
});

// ─────────────────────────────────────────────────────────────────────────────
// The real api process
// ─────────────────────────────────────────────────────────────────────────────
//
// A route refusal proven by calling a handler module is module evidence. The
// criteria this helper serves are claims about what the running `api`
// accepts, so these boot `bun run src/api/index.ts` — what the compose api
// service runs — against the calling file's own database and ask it over HTTP.

const backendDir = join(import.meta.dir, "..", "..");

export interface ApiProcess {
  readonly base: string;
  stop(): void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Boot the api on a free port, connected to the database this test file's
 * pool is on (tests/support/clean-db.ts moves the pool, not DATABASE_URL).
 *
 * `env` is laid over the test process's own; `preload` names a module passed
 * to `bun --preload`, which is how a red control swaps a guard back to its old
 * shape inside the real process without touching the source tree.
 */
export async function bootApi(opts: { env?: Record<string, string>; preload?: string } = {}): Promise<ApiProcess> {
  const [{ db }] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${db}`;
  const port = await freePort();
  const argv = ["bun", "run", ...(opts.preload ? ["--preload", opts.preload] : []), "src/api/index.ts"];
  const proc = Bun.spawn(argv, {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: url.toString(), API_PORT: String(port), ...opts.env },
    stdout: "ignore",
    stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`api exited with ${proc.exitCode}:\n${await new Response(proc.stderr as ReadableStream).text()}`);
    }
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`api never served /health on :${port}`);
    }
    await Bun.sleep(100);
  }
  return { base, stop: () => proc.kill() };
}

/**
 * A `bun --preload` module that rewrites ONE source file as the api loads it:
 * `needle` becomes `replacement` in the module whose path ends with `suffix`.
 * The needle must be present — a missing one throws at load, so the api fails
 * to boot and the red control goes red instead of silently testing the
 * unmodified code.
 */
export function writeRedControlPreload(suffix: string, needle: string, replacement: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "rm-red-control-")), "preload.ts");
  const filter = `${suffix.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`;
  writeFileSync(
    file,
    `import { plugin } from "bun";
const needle = ${JSON.stringify(needle)};
const replacement = ${JSON.stringify(replacement)};
plugin({
  name: "red-control",
  setup(build) {
    build.onLoad({ filter: new RegExp(${JSON.stringify(filter)}) }, async (args) => {
      const contents = await Bun.file(args.path).text();
      if (!contents.includes(needle)) throw new Error("red control: needle not found in " + args.path);
      return { contents: contents.replace(needle, replacement), loader: "ts" };
    });
  },
});
`,
  );
  return file;
}

export interface Probe {
  status: number;
  body: string;
}

/**
 * One request to the running api. A body is read in full unless it is an
 * event stream, which is cancelled and reported as such: a stream is what a
 * wrongly-admitted subscriber would receive, and waiting on it would hang.
 */
export async function probe(
  api: ApiProcess,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Probe> {
  const res = await fetch(`${api.base}${path}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    await res.body?.cancel();
    return { status: res.status, body: "<event-stream>" };
  }
  return { status: res.status, body: await res.text() };
}
