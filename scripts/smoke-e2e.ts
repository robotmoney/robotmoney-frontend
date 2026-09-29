// The full-stack lifecycle verdict (issue #1026, smoke spec §10 W1 and W3;
// scheduler spec §10; plan P6). One command, run unattended, against a real
// `bun smoke` stack it boots itself and always takes down again:
//
//   RM_ENV=stage bun scripts/smoke-e2e.ts [--instance <name>] [--keep] [--attached]
//
// `--attached` skips the boot of step 1 for a caller that ran it already (the
// e2e workflow does, as its own step) and starts from the stack it left.
//
//  1. Boots `bun smoke --local blank --migrate --seed` with the committed
//     fixture credential file (test-fixtures/smoke/empty-roster.credentials.json),
//     stdin closed, no overlay. Exit 0 at readiness, no prompt printed, a
//     receipt on disk with every check passed, the real scheduler healthy, and
//     one `collecting` session for every active subject (the seed makes the
//     blank database hold active subjects).
//  2. Seats the fixture participants (test-fixtures/smoke/participants.fixture.json,
//     fixture keys only) through the running API and boots the same instance
//     again from a roster naming them: an agent and a judge running as
//     containers, `restart: unless-stopped`.
//  3. Creates one subject with a short epoch duration N through the admin
//     route and observes ONE turnover: after the first window closes the
//     subject holds exactly two sessions, the first `published`, the second
//     `collecting` and closing on the grid one N later; the first settled
//     `not_judged` (judge mode off) or `no_consensus` (enforce, no judgement),
//     with no take, judgement or consensus receipt written for it.
//  4. Removes the scheduler's token file: a rerun refuses, naming the file.
//  5. Stops the scheduler container: a rerun refuses, naming the container.
//  6. `bun smoke:down`, whatever happened above (unless --keep).
//
// It exits 1 naming every check that failed. Fixture keys only: nothing here
// reads or writes a real secret, and the instance's own state directory holds
// the tokens and the roster file it generates.
import { createPrivateKey } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import { fetchSchedulerHealth } from "./lib/smoke-readiness-scheduler.ts";
import { readReceipt } from "./lib/smoke-journal.ts";
import { readStackState, selectExistingInstance, stateRoot, type InstancePaths } from "./lib/smoke-state.ts";

const repoRoot = join(import.meta.dir, "..");
const EMPTY_ROSTER = join(repoRoot, "test-fixtures", "smoke", "empty-roster.credentials.json");
const PARTICIPANTS = join(repoRoot, "test-fixtures", "smoke", "participants.fixture.json");

/** The short epoch, in seconds. A first epoch closes between N/2 and 3N/2 after it opens (scheduler spec §2.2). */
const EPOCH_SECONDS = Number(process.env.E2E_EPOCH_SECONDS ?? 40);
const JUDGING_SECONDS = Number(process.env.E2E_JUDGING_SECONDS ?? 10);
const SUBJECT_ID = "e2e-short-epoch";
const BOOT_TIMEOUT_MS = 25 * 60 * 1000;

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
// The first boot passes --instance only when asked; every later command names
// the instance that boot printed (a CI job's name is derived, never chosen).
let instance = flag("--instance");
const keep = argv.includes("--keep");
const instanceArgs = (): string[] => (instance ? ["--instance", instance] : []);

// The environment every child runs in. RM_ENV=stage is the policy (§4.1). With
// no model credential at all the boot's inference preflight would refuse the
// default paid model, and the judge refuses a keyless family, so a placeholder
// key stands in: it reaches no container but the participants' own env files
// (no-model-key-outside-participants) and is never sent anywhere that checks it.
const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
env.RM_ENV ??= "stage";
if (!env.OPENCODE_API_KEY) {
  env.OPENCODE_API_KEY = "sk-placeholder-never-forwarded";
  env.AGENT_MODEL = "deepseek";
}

const failures: string[] = [];
function check(ok: boolean, message: string, detail?: string): boolean {
  console.log(`  ${ok ? "✓" : "✗"} ${message}${!ok && detail ? `\n      ${detail.split("\n").join("\n      ")}` : ""}`);
  if (!ok) failures.push(message);
  return ok;
}

interface Run {
  code: number;
  out: string;
}

/** Runs argv with stdin closed, echoing its output and returning it. */
async function run(cmd: string[], label: string): Promise<Run> {
  console.log(`\n[e2e] ${label}: ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, { cwd: repoRoot, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let out = "";
  const pump = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      out += text;
      sink.write(text);
    }
  };
  const timer = setTimeout(() => proc.kill("SIGKILL"), BOOT_TIMEOUT_MS);
  await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>, process.stdout), pump(proc.stderr as ReadableStream<Uint8Array>, process.stderr)]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out };
}

const smokeArgv = (mode: "blank" | "volume", extra: string[]): string[] => [
  "bun", "--no-env-file", "scripts/smoke.ts", "--local", mode, ...extra, ...instanceArgs(),
];

function docker(args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["docker", ...args], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString().trim() };
}

function serviceContainer(project: string, service: string): string | undefined {
  return docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`])
    .out.split("\n")[0] || undefined;
}

/** One read-only query in the stack's own postgres container, as the local superuser that created it. */
function sql(project: string, statement: string): string {
  const id = serviceContainer(project, "postgres");
  if (!id) throw new Error("the stack's postgres container is not there");
  const r = docker(["exec", id, "psql", "-X", "-U", "robotmoney", "-d", "robotmoney", "-Atc", statement]);
  if (r.code !== 0) throw new Error(`psql failed: ${r.out}`);
  return r.out;
}

async function until<T>(what: string, timeoutMs: number, probe: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await Bun.sleep(1000);
  }
}

/** The Ed25519 identity whose private seed is exactly `d` (base64url). */
function identityFromSeed(d: string): { privateJwk: Record<string, unknown>; publicKeyB64: string } {
  const seed = Buffer.from(d, "base64url");
  if (seed.length !== 32 || seed.toString("base64url") !== d) throw new Error(`${d} is not a canonical 32-byte base64url seed`);
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const jwk = createPrivateKey({ key: Buffer.concat([pkcs8Prefix, seed]), format: "der", type: "pkcs8" }).export({ format: "jwk" }) as Record<string, unknown>;
  return { privateJwk: jwk, publicKeyB64: Buffer.from(String(jwk.x), "base64url").toString("base64") };
}

interface FixtureEntry { name: string; privateD: string; modelKey: string }

async function seat(api: string, operatorToken: string, planted: FixtureEntry, role: "member" | "judge") {
  const { privateJwk, publicKeyB64 } = identityFromSeed(planted.privateD);
  const res = await fetch(`${api}${ROUTES.swarm.admin.members}`, {
    method: "POST",
    headers: { "X-Automation-Token": operatorToken, "Content-Type": "application/json" },
    body: JSON.stringify({ name: planted.name, publicKey: publicKeyB64 }),
  });
  const body = (await res.json()) as { member?: { id?: string; version?: number }; token?: string };
  if (res.status !== 201 || !body.member?.id || !body.token) throw new Error(`seating ${planted.name} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  if (role === "judge") {
    const r = await fetch(`${api}${ROUTES.swarm.admin.members}/${encodeURIComponent(body.member.id)}/role`, {
      method: "POST",
      headers: { "X-Automation-Token": operatorToken, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "judge", expectedVersion: body.member.version ?? 1 }),
    });
    if (!r.ok) throw new Error(`making ${planted.name} a judge failed: HTTP ${r.status} ${await r.text()}`);
  }
  return { memberId: body.member.id, publicKeyB64, privateJwk, bearer: body.token, modelKey: planted.modelKey };
}

async function getJson<T>(url: string, token?: string): Promise<T> {
  const res = await fetch(url, { headers: token ? { "X-Automation-Token": token } : {} });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

/** The scheduler's health, read from the host port Docker published for it. */
async function schedulerHealth(project: string) {
  const id = serviceContainer(project, "system-scheduler");
  if (!id) return null;
  const port = docker(["port", id, "8090/tcp"]).out.split("\n")[0]?.split(":").pop();
  return port ? fetchSchedulerHealth(`http://127.0.0.1:${port}/health`) : null;
}

function readinessChecks(paths: InstancePaths) {
  const receipt = readReceipt(paths);
  return receipt?.readiness ?? [];
}

async function main(): Promise<void> {
  if (argv.includes("--attach")) {
    // Development aid: steps 1 and 2 already ran against a stack kept with --keep.
    if (!instance) throw new Error("--attach needs --instance");
    const paths = selectExistingInstance(stateRoot(env), instance);
  instance ??= basename(paths.dir);
    const stack = readStackState(paths)!;
    await turnoverAndRefusals({
      paths,
      project: stack.project,
      api: `http://127.0.0.1:${stack.apiPort}`,
      operatorToken: readFileSync(paths.tokenFiles.operator, "utf8").trim(),
      roster: join(paths.dir, "e2e-roster.credentials.json"),
    });
    return;
  }
  // ── 1. The documented boot ───────────────────────────────────────────────
  // `--attached`: the documented boot already ran (CI runs it as its own step),
  // so this run starts from the stack it left and checks what it left.
  const attached = argv.includes("--attached");
  console.log(`\n=== 1. bun smoke --local blank --migrate --seed, fixture credential file, no overlay${attached ? " (already booted)" : ""} ===`);
  if (!attached) {
    const boot = await run(smokeArgv("blank", ["--migrate", "--seed", "--credentials", EMPTY_ROSTER]), "boot");
    check(boot.code === 0, "the boot exits 0 at readiness", boot.out.slice(-2500));
    if (boot.code !== 0) return;
    check(!/rm_owner password|type y to continue/.test(boot.out), "the boot printed no interactive prompt");
    instance ??= boot.out.match(/^\s*Instance:\s+(\S+)/m)?.[1];
    if (!instance) throw new Error("the READY table named no instance");
  }
  const paths = selectExistingInstance(stateRoot(env), instance);
  instance ??= basename(paths.dir);
  const stack = readStackState(paths);
  if (!stack) throw new Error(`no stack record under ${paths.dir}`);
  const project = stack.project;
  const api = `http://127.0.0.1:${stack.apiPort}`;
  const operatorToken = readFileSync(paths.tokenFiles.operator, "utf8").trim();
  console.log(`\n[e2e] instance ${instance}, project ${project}, api ${api}`);

  const receipt = readReceipt(paths);
  check(receipt !== null, "a receipt is present", paths.receiptFile);
  const results = readinessChecks(paths);
  check(results.length > 0 && results.every((c) => c.pass), "every readiness check in the receipt passed", JSON.stringify(results.filter((c) => !c.pass)));

  const subjects = (await getJson<{ subjects: { id: string; status: string }[] }>(`${api}${ROUTES.swarm.admin.subjects}`, operatorToken)).subjects;
  const active = subjects.filter((s) => s.status === "active").map((s) => s.id);
  check(active.length > 0, `the blank boot seeded active subjects (${active.join(", ") || "none"})`);
  const collectingIds = (): string[] =>
    sql(project, "SELECT subject_id FROM swarm_sessions WHERE state = 'collecting' ORDER BY subject_id").split("\n").filter(Boolean);
  const collecting = collectingIds();
  check(
    active.length > 0 && active.every((id) => collecting.filter((c) => c === id).length === 1) && collecting.length === active.length,
    "exactly one collecting session per active subject",
    `active ${JSON.stringify(active)} collecting ${JSON.stringify(collecting)}`,
  );

  const health = await schedulerHealth(project);
  check(
    health !== null && health.authenticated && health.streamSynchronized && health.initialRebuildComplete && health.exhausted.length === 0,
    "the real scheduler is healthy: authenticated, synchronized, rebuilt, no exhausted work",
    JSON.stringify(health),
  );

  // ── 2. Participants as containers ────────────────────────────────────────
  console.log("\n=== 2. the fixture roster: an agent and a judge as standing containers ===");
  const fixture = JSON.parse(readFileSync(PARTICIPANTS, "utf8")) as { agents: Record<string, FixtureEntry>; judges: Record<string, FixtureEntry> };
  const agents: Record<string, unknown> = {};
  const judges: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(fixture.agents)) agents[name] = await seat(api, operatorToken, entry, "member");
  for (const [name, entry] of Object.entries(fixture.judges)) judges[name] = await seat(api, operatorToken, entry, "judge");
  const roster = join(paths.dir, "e2e-roster.credentials.json");
  writeFileSync(roster, JSON.stringify({ agents, judges }), { mode: 0o600 });
  chmodSync(roster, 0o600);

  const rosterBoot = await run(smokeArgv("volume", ["--credentials", roster]), "roster boot");
  check(rosterBoot.code === 0, "the roster boot exits 0 at readiness", rosterBoot.out.slice(-2500));
  if (rosterBoot.code !== 0) return;

  const participantIds = docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=robotmoney.participant"]).out.split("\n").filter(Boolean);
  const described = participantIds.map((id) => {
    const r = docker(["inspect", "--format", '{{index .Config.Labels "robotmoney.participant.kind"}}:{{index .Config.Labels "robotmoney.participant.name"}}|{{.State.Status}}|{{.HostConfig.RestartPolicy.Name}}', id]);
    const [who = "", state = "", restart = ""] = r.out.split("|");
    return { who, state, restart };
  });
  check(
    JSON.stringify(described.map((d) => d.who).sort()) === JSON.stringify([...Object.keys(fixture.agents).map((n) => `agent:${n}`), ...Object.keys(fixture.judges).map((n) => `judge:${n}`)].sort()),
    "the participant containers are exactly the fixture agent and judge",
    JSON.stringify(described),
  );
  check(described.length > 0 && described.every((d) => d.state === "running" && d.restart === "unless-stopped"), "each participant is running with restart: unless-stopped", JSON.stringify(described));

  // Every application service, not only the participants.
  const services = docker(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`, "--filter", "label=com.docker.compose.oneoff=False"]).out.split("\n").filter(Boolean);
  const policies = services.map((id) => docker(["inspect", "--format", '{{index .Config.Labels "com.docker.compose.service"}}={{.HostConfig.RestartPolicy.Name}}', id]).out);
  check(policies.length > 0 && policies.every((p) => p.endsWith("=unless-stopped")), "every long-lived service carries restart: unless-stopped", policies.join(", "));

  const fresh = readStackState(paths);
  await turnoverAndRefusals({ paths, project, api: `http://127.0.0.1:${(fresh ?? stack).apiPort}`, operatorToken, roster });
}

interface Ctx {
  paths: InstancePaths;
  project: string;
  api: string;
  operatorToken: string;
  roster: string;
}

async function turnoverAndRefusals({ paths, project, api, operatorToken, roster }: Ctx): Promise<void> {
  // ── 3. One turnover after one short epoch ────────────────────────────────
  console.log(`\n=== 3. one turnover: a subject with epoch duration ${EPOCH_SECONDS}s ===`);
  const created = await fetch(`${api}${ROUTES.swarm.admin.subjects}`, {
    method: "POST",
    headers: { "X-Automation-Token": operatorToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: SUBJECT_ID,
      name: "E2E Short Epoch",
      recommendationType: "position_actions",
      epochDuration: EPOCH_SECONDS,
      judgingDurationSeconds: JUDGING_SECONDS,
    }),
  });
  check(created.status === 201, `the admin route created subject ${SUBJECT_ID} with epochDuration ${EPOCH_SECONDS}`, `HTTP ${created.status} ${await created.text()}`);
  const sessionRows = (): { id: string; state: string; closes: string; outcome: string; mode: string }[] =>
    sql(project, `SELECT id || '|' || state || '|' || coalesce(extract(epoch FROM window_closes_at)::text, '') || '|' || coalesce(judging_outcome, '') || '|' || coalesce(judge_mode, '') FROM swarm_sessions WHERE subject_id = '${SUBJECT_ID}' ORDER BY generated_at, id`)
      .split("\n").filter(Boolean).map((l) => {
        const [id = "", state = "", closes = "", outcome = "", mode = ""] = l.split("|");
        return { id, state, closes, outcome, mode };
      });

  const opened = await until("the scheduler to open the subject's first epoch", 60_000, () => sessionRows().find((r) => r.state === "collecting"));
  const firstClose = Number(opened.closes);
  check(firstClose - Date.now() / 1000 > 0, `the scheduler opened the first epoch; it closes in ${Math.round(firstClose - Date.now() / 1000)}s`);

  // The second session exists once the first has turned over; a first window is
  // at most 3N/2 long, so N plus the settlement slack bounds the wait.
  await until("the turnover to open the second epoch", (EPOCH_SECONDS * 1.5 + JUDGING_SECONDS + 60) * 1000, () => sessionRows().length >= 2 || undefined);
  const settled = await until("the first session to settle", (JUDGING_SECONDS + 60) * 1000, () => sessionRows().find((r) => r.id === opened.id)?.state === "published" || undefined);
  void settled;
  const rows = sessionRows();
  const first = rows.find((r) => r.id === opened.id)!;
  const second = rows.find((r) => r.id !== opened.id)!;
  check(rows.length === 2, "exactly two sessions after the turnover", JSON.stringify(rows));
  check(first.state === "published", "the first session is published", JSON.stringify(first));
  check(second?.state === "collecting", "the second session is collecting", JSON.stringify(second));
  check(
    second !== undefined && Math.abs(Number(second.closes) - (firstClose + EPOCH_SECONDS)) < 1,
    `the second window closes on the grid, one epoch (${EPOCH_SECONDS}s) after the first`,
    `first ${firstClose} second ${second?.closes}`,
  );
  const expected = first.mode === "off" ? "not_judged" : "no_consensus";
  check(first.outcome === expected, `the first session settled ${expected} (judge mode ${first.mode || "unset"}, no consensus given)`, JSON.stringify(first));
  const content = sql(project, `SELECT (SELECT count(*) FROM swarm_recommendations WHERE session_id = '${first.id}') || '|' || (SELECT count(*) FROM swarm_session_judgements WHERE session_id = '${first.id}') || '|' || (SELECT count(*) FROM swarm_consensus_receipts WHERE session_id = '${first.id}')`);
  check(content === "0|0|0", "no take, judgement or consensus receipt was fabricated for the settled session", `takes|judgements|receipts = ${content}`);
  await Bun.sleep(3000);
  check(sessionRows().length === 2, "no third session appeared inside the second window");

  // ── 4. The scheduler's token file is gone ────────────────────────────────
  console.log("\n=== 4. remove the scheduler's token file, rerun ===");
  const tokenFile = paths.tokenFiles["system-scheduler"];
  const saved = readFileSync(tokenFile, "utf8");
  Bun.spawnSync(["rm", "-f", tokenFile]);
  const noToken = await run(smokeArgv("volume", ["--credentials", roster]), "rerun without the token file");
  check(noToken.code !== 0, "the rerun fails without the scheduler's token file");
  check(noToken.out.includes(tokenFile) || /system-scheduler[^\n]*token|token[^\n]*system-scheduler/.test(noToken.out), "the failure names the scheduler's token file", noToken.out.slice(-1500));
  writeFileSync(tokenFile, saved, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);

  // ── 5. The scheduler container is stopped ────────────────────────────────
  // Two observations, kept apart because they differ. `smoke:status` reads the
  // stack as it is and must name the stopped scheduler; the receipt is history
  // (§6.3). A rerun of `bun smoke` is a deployment, which starts what is
  // stopped exactly as it does after `smoke:down`, so it is NOT expected to
  // refuse: it is run to prove it recovers the scheduler with no
  // `docker restart` of ours, and its outcome is printed, not gated.
  console.log("\n=== 5. stop the scheduler container, observe, rerun ===");
  const schedulerId = serviceContainer(project, "system-scheduler");
  if (!schedulerId) throw new Error("no system-scheduler container to stop");
  docker(["stop", schedulerId]);
  const status = await run(["bun", "--no-env-file", "scripts/smoke-status.ts", ...instanceArgs()], "smoke:status with the scheduler stopped");
  check(status.code === 0 && /system-scheduler is NOT RUNNING/.test(status.out), "smoke:status names the stopped scheduler as not running now", status.out.slice(-1200));
  const stopped = await run(smokeArgv("volume", ["--credentials", roster]), "rerun with the scheduler stopped");
  const after = await schedulerHealth(project);
  console.log(
    `[e2e] rerun with the scheduler stopped exited ${stopped.code}; scheduler afterwards: ${after === null ? "not answering" : after.authenticated && after.streamSynchronized ? "healthy" : "unhealthy"}`,
  );
  check(stopped.code === 0 ? after !== null && after.authenticated : /system-scheduler/.test(stopped.out), "the rerun either recovered the scheduler or refused naming it", stopped.out.slice(-1200));
}

let fatal: unknown;
try {
  await main();
} catch (error) {
  fatal = error;
  console.error(`\n[e2e] aborted: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  if (keep) {
    console.log("\n[e2e] --keep: the stack is left up; stop it with `bun smoke:down`.");
  } else {
    const down = Bun.spawnSync(["bun", "--no-env-file", "scripts/smoke-down.ts", ...instanceArgs()], { cwd: repoRoot, env, stdout: "inherit", stderr: "inherit" });
    console.log(`[e2e] smoke:down exited ${down.exitCode}`);
    if (down.exitCode !== 0) failures.push("smoke:down did not exit 0");
  }
}

if (fatal !== undefined || failures.length > 0) {
  console.error(`\n[e2e] FAILED${failures.length ? `:\n  - ${failures.join("\n  - ")}` : ""}`);
  process.exit(1);
}
console.log("\n[e2e] every lifecycle check passed");
