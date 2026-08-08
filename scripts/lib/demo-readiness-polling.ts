// The standing demo's READINESS-PROBE POLLING concern (issue #456 — extracted
// out of scripts/lib/demo-main.ts alongside the TUI state machine in
// demo-tui-view.ts). Two independent polls:
//
//  - legacy research-queue polling (observability cleanup debt): D25 moved
//    regime/research cadence to the independent analytics-producer, but these
//    polls still read the retired regime.classify/research.refresh queue rows
//    for historical TUI compatibility — they neither observe nor control
//    producer runs. Producer-native run/cadence telemetry must replace this
//    view. Polls over `docker compose exec -T postgres psql`.
//  - container health polling: the REAL docker container status (not just the
//    HTTP /health endpoint), so a crash / restart-loop / unhealthy healthcheck
//    surfaces in the Startup pane.
//
// createReadinessPolling() takes every piece of state it needs as an explicit
// dependency and returns bound methods over PRIVATE instance state (the
// research-notes cache, the next-run cache, the health-checking flag) — no
// module-level mutable state of its own, so a caller can create one instance
// per demo boot (or a fake one in a test) instead of this being process-wide.
import { path as routePath, ROUTES } from "@robotmoney/contract";
import {
  setContainer,
  type DemoState,
  type Phase,
  type ResearchEntry,
} from "./demo-tui-view.ts";

export interface ReadinessPollingDeps {
  repoRoot: string;
  dockerEnv: Record<string, string>;
  externalPgEnabled: boolean;
  dbUser: string;
  dbName: string;
  researchKeys: readonly string[];
  /** A getter, not a snapshot: backendUrl is unknown until Docker assigns the
   *  host port, and this factory is created before that happens. */
  getBackendUrl: () => string;
  state: DemoState;
  log: (msg: string) => void;
}

interface PsEntry { Service?: string; Name?: string; State?: string; Health?: string; ExitCode?: number; }

export function classifyContainer(e: PsEntry): { phase: Phase; detail?: string } {
  const st = (e.State ?? "").toLowerCase();
  const h = (e.Health ?? "").toLowerCase();
  if (st === "running") {
    if (h === "starting") return { phase: "starting", detail: "health: starting" };
    if (h === "unhealthy") return { phase: "failed", detail: "unhealthy" };
    return { phase: "healthy", detail: h || undefined }; // healthy, or no healthcheck defined
  }
  if (st === "restarting") return { phase: "failed", detail: "restarting" };
  if (st === "exited" || st === "dead") return { phase: "failed", detail: `exited${e.ExitCode != null ? ` ${e.ExitCode}` : ""}` };
  if (st === "created" || st === "paused") return { phase: "starting", detail: st };
  return { phase: "starting", detail: st || "checking" };
}

export function mapJobState(status: string): ResearchEntry["state"] {
  if (status === "pending") return "queued";
  if (status === "running") return "running";
  return "done"; // succeeded | failed | dead
}

// One-shot post-ready probe (issue #553 / D32): has the admin credential been
// claimed? true ⇒ the per-boot ADMIN_TOKEN is superseded as the operator
// credential and must never be displayed (TUI Admin-pass line, READY table).
// Probe failure (an unreachable/unmigrated backend) reports false — fall back
// to the historical pre-claim display rather than hiding the only way in.
export async function probeAdminClaimed(backendUrl: string): Promise<boolean> {
  const body: { claimed?: unknown } | null = await fetch(`${backendUrl}${ROUTES.admin.isClaimed}`)
    .then((r) => (r.ok ? (r.json() as Promise<{ claimed?: unknown }>) : null))
    .catch(() => null);
  return body?.claimed === true;
}

export function createReadinessPolling(deps: ReadinessPollingDeps) {
  const { repoRoot, dockerEnv, externalPgEnabled, dbUser, dbName, researchKeys, getBackendUrl, state, log } = deps;

  const researchNotes = new Map<number, string>();
  interface NextRun { secondsUntil: number; fetchedAt: number; }
  const nextRuns: Record<string, NextRun> = {};
  let healthChecking = false;
  let researchTimer: ReturnType<typeof setTimeout> | null = null;
  let healthTimer: ReturnType<typeof setTimeout> | null = null;

  function secsUntilNext(kind: string): number | null {
    const nr = nextRuns[kind];
    if (!nr) return null;
    return Math.max(0, Math.round(nr.secondsUntil - (Date.now() - nr.fetchedAt) / 1000));
  }

  // Both legacy polls below read the queue tables directly. With the ephemeral
  // container that is `docker compose exec -T postgres psql`; with
  // --external-pg there is no container to exec into, so a one-shot
  // postgres:17-alpine client is run instead (the same image the ephemeral
  // service uses, so it is usually already local; the first poll pulls it if
  // not, and these polls are defensive — a failure is logged and skipped
  // either way).
  //
  // The URL crosses into the container by `-e DATABASE_URL` with NO value,
  // i.e. inherited from dockerEnv, so the managed server's password never
  // appears in this host's process list the way `-e DATABASE_URL=<url>` would
  // put it there.
  function psqlQuery(q: string): Bun.SyncSubprocess {
    const argv = externalPgEnabled
      ? ["docker", "run", "--rm", "-e", "DATABASE_URL", "postgres:17-alpine", "sh", "-c",
         `psql "$DATABASE_URL" -tAF'|' -c ${JSON.stringify(q)}`]
      : ["docker", "compose", "exec", "-T", "postgres", "psql", "-U", dbUser, "-d", dbName, "-tAF", "|", "-c", q];
    return Bun.spawnSync(argv, { cwd: repoRoot, env: dockerEnv, stdout: "pipe", stderr: "pipe" });
  }

  async function fetchResearchNote(id: number, kind: string, failed: boolean, err: string): Promise<void> {
    if (failed) { researchNotes.set(id, `failed: ${err.split("\n")[0] || "error"}`); return; }
    try {
      // Historical kind-scoped summary for a terminal legacy queue row.
      let note = "updated";
      const backendUrl = getBackendUrl();
      if (kind === "regime.classify") {
        const snap = await fetch(`${backendUrl}${ROUTES.dashboards.regimeSnapshots}?range=1`).then((r) => (r.ok ? r.json() : null));
        const latest = snap?.latest;
        note = latest
          ? `regime → ${latest.regime ?? "?"}${latest.composite != null ? ` ${Number(latest.composite).toFixed(2)}` : ""}`
          : "regime updated";
      } else if (kind === "research.refresh") {
        const sig = await fetch(`${backendUrl}${routePath(ROUTES.dashboards.researchSignal, { key: researchKeys[0] })}`).then((r) => (r.ok ? r.json() : null));
        note = sig?.signalKey ? `research: ${sig.signalKey}` : "research updated";
      }
      researchNotes.set(id, `${note} (report written)`);
    } catch (e) {
      log(`research note fetch failed for job ${id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function pollResearch(): Promise<void> {
    const q =
      "SELECT j.id, j.kind, j.status, " +
      "COALESCE(to_char(jr.finished_at,'HH24:MI:SS'), to_char(j.run_after,'HH24:MI:SS')), " +
      "COALESCE(jr.error,'') " +
      "FROM jobs j LEFT JOIN job_runs jr ON jr.job_id = j.id " +
      "WHERE j.kind IN ('regime.classify','research.refresh') ORDER BY j.id DESC LIMIT 8";
    const r = psqlQuery(q);
    if (r.exitCode !== 0) { log(`research poll query failed (exit ${r.exitCode})`); return; }
    const rows = new TextDecoder().decode(r.stdout).trim().split("\n").filter(Boolean);
    const entries: ResearchEntry[] = [];
    for (const row of rows) {
      const [idStr, kind, status, at, err] = row.split("|");
      const id = Number(idStr);
      if (!Number.isFinite(id)) continue;
      const st = mapJobState(status);
      const failed = status === "failed" || status === "dead";
      // First time we see a finished run, fetch its one-line summary from the API.
      if (st === "done" && !researchNotes.has(id)) {
        researchNotes.set(id, failed ? "failed" : "done — fetching summary…");
        void fetchResearchNote(id, kind, failed, err);
      }
      const note = st === "done" ? (researchNotes.get(id) ?? "done") : st === "running" ? "running…" : "queued";
      entries.push({ id, kind, state: st, at, note });
    }
    state.research = entries;
  }

  // Poll retired consumer schedule rows for backward-compatible display only.
  // This is not producer-native cadence telemetry. Defensive: any failure is
  // logged and skipped.
  async function pollNextRuns(): Promise<void> {
    const q =
      "SELECT kind, MIN(GREATEST(0, EXTRACT(EPOCH FROM (next_run_at - now()))))::int " +
      "FROM job_schedules WHERE enabled AND next_run_at IS NOT NULL " +
      "AND kind IN ('regime.classify','research.refresh') GROUP BY kind";
    const r = psqlQuery(q);
    if (r.exitCode !== 0) { log(`next-run poll query failed (exit ${r.exitCode})`); return; }
    const rows = new TextDecoder().decode(r.stdout).trim().split("\n").filter(Boolean);
    for (const row of rows) {
      const [kind, secs] = row.split("|");
      const n = Number(secs);
      if (kind && Number.isFinite(n)) nextRuns[kind] = { secondsUntil: n, fetchedAt: Date.now() };
    }
  }

  function startResearchPolling(): void {
    const tick = async () => {
      try { await pollResearch(); } catch (e) { log(`research poll error: ${e instanceof Error ? e.message : e}`); }
      try { await pollNextRuns(); } catch (e) { log(`next-run poll error: ${e instanceof Error ? e.message : e}`); }
      researchTimer = setTimeout(() => void tick(), 4000);
    };
    void tick();
  }

  // Actively check the REAL docker container status. Polls `docker compose
  // ps` and maps each service's State+Health to a pane phase: ✓ healthy ·
  // ✗ errored · spinner while starting/checking. Only postgres declares a
  // Docker healthcheck; for api/worker the signal is process state (running
  // vs exited/restarting) — i.e. the "absence of errors". Fully defensive:
  // any failure is logged and skipped, never crashing the TUI.
  async function pollContainerHealth(): Promise<void> {
    healthChecking = true;
    try {
      // Async spawn (not spawnSync) so the render loop keeps animating the
      // refresh spinner while docker runs. `-a` includes stopped/exited
      // containers.
      const proc = Bun.spawn(["docker", "compose", "ps", "-a", "--format", "json"], {
        cwd: repoRoot, env: dockerEnv, stdout: "pipe", stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      if (proc.exitCode !== 0) { log(`container health poll failed (exit ${proc.exitCode})`); return; }
      // Compose emits either NDJSON (one object per line, v2.21+) or a JSON array.
      const entries: PsEntry[] = [];
      const trimmed = out.trim();
      if (trimmed.startsWith("[")) {
        try { entries.push(...(JSON.parse(trimmed) as PsEntry[])); } catch { /* skip */ }
      } else {
        for (const line of trimmed.split("\n").filter(Boolean)) {
          try { entries.push(JSON.parse(line) as PsEntry); } catch { /* skip malformed line */ }
        }
      }
      for (const c of state.containers) {
        const e = entries.find((x) => x.Service === c.name || x.Name?.includes(`-${c.name}-`) || x.Name?.includes(`_${c.name}_`));
        if (!e) { setContainer(state, c.name, "failed", "not found"); continue; }
        const { phase, detail } = classifyContainer(e);
        setContainer(state, c.name, phase, detail ?? "");
      }
    } catch (e) {
      log(`container health poll error: ${e instanceof Error ? e.message : e}`);
    } finally {
      healthChecking = false;
    }
  }

  function startHealthPolling(): void {
    const tick = async () => {
      await pollContainerHealth();
      healthTimer = setTimeout(() => void tick(), 3000);
    };
    void tick();
  }

  return {
    pollResearch,
    pollNextRuns,
    startResearchPolling,
    pollContainerHealth,
    startHealthPolling,
    secsUntilNext,
    isHealthChecking: () => healthChecking,
    // Exposed for tests / diagnostics only — nothing in demo-main.ts reads
    // these timer handles today (parity with the pre-extraction behaviour,
    // where they were likewise write-only).
    _internal: { researchTimer: () => researchTimer, healthTimer: () => healthTimer },
  };
}

export type ReadinessPolling = ReturnType<typeof createReadinessPolling>;
