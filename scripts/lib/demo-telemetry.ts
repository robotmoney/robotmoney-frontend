// Container telemetry: what the containers are DOING, as opposed to what the
// boot asked them to do.
//
// WHY. The demo's Startup pane reported a container's phase from the
// orchestrator's own point of view — "healthy" meant "the boot got past this",
// and it never changed again. So a worker lane that crashed and was restarted
// eight times by Docker still rendered a green tick, and the only way to learn
// otherwise was `docker compose logs`. The restarts themselves were invisible:
// every service carries `restart: unless-stopped`, so Docker was already
// restarting with its built-in exponential backoff (100ms doubling, capped near
// a minute) and nothing surfaced it.
//
// WHAT IT IS NOT. This does not restart anything. Docker's policy is the
// supervisor; a second one in the orchestrator would fight it (and would have
// to set `restart: no` to avoid double-restarting). This only observes.
//
// Pure by construction — parsing, selection and rendering are functions of
// their inputs, executed by scripts/tests/unit/demo-telemetry.test.ts. The
// caller owns spawning docker.
import { color, hr, truncate } from "./tui.ts";

export type HealthState = "healthy" | "unhealthy" | "starting" | "none";

export interface ContainerTelemetry {
  service: string;
  running: boolean;
  restarts: number;
  /** Exit code of the LAST run. Meaningless while running; 0 when never exited. */
  exitCode: number;
  oomKilled: boolean;
  health: HealthState;
}

/**
 * One line per container, field-separated. Asking docker for exactly the six
 * fields we render beats parsing whole inspect JSON: the format string IS the
 * schema, so a docker change surfaces as a parse miss rather than a silently
 * absent key.
 */
export const TELEMETRY_FORMAT = [
  '{{index .Config.Labels "com.docker.compose.service"}}',
  "{{.State.Running}}",
  "{{.RestartCount}}",
  "{{.State.ExitCode}}",
  "{{.State.OOMKilled}}",
  "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
].join("|");

function asHealth(raw: string): HealthState {
  return raw === "healthy" || raw === "unhealthy" || raw === "starting" ? raw : "none";
}

/** Parse `docker inspect --format TELEMETRY_FORMAT` output. Malformed lines are
 *  skipped rather than thrown on: this runs on a timer beside a live TUI, and a
 *  container removed mid-poll must not take the boot down. */
export function parseTelemetry(stdout: string): ContainerTelemetry[] {
  const out: ContainerTelemetry[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split("|");
    if (parts.length < 6 || !parts[0]) continue;
    const restarts = Number(parts[2]);
    const exitCode = Number(parts[3]);
    if (!Number.isFinite(restarts) || !Number.isFinite(exitCode)) continue;
    out.push({
      service: parts[0]!,
      running: parts[1] === "true",
      restarts,
      exitCode,
      oomKilled: parts[4] === "true",
      health: asHealth(parts[5]!),
    });
  }
  return out;
}

/**
 * The short suffix the container tile carries, or undefined when there is
 * nothing worth saying.
 *
 * Silence is the point: a healthy container that has never restarted renders as
 * bare as it always did, so anything shown is a real signal. Restarts are
 * reported even once the container is up again — a lane that crashed five times
 * and is currently running is NOT the same as one that never crashed, and the
 * old display could not tell them apart.
 */
export function telemetryDetail(t: ContainerTelemetry | undefined): string | undefined {
  if (!t) return undefined;
  const bits: string[] = [];
  if (t.restarts > 0) bits.push(`${t.restarts}×restarted`);
  if (t.oomKilled) bits.push("OOM-KILLED");
  if (!t.running && t.exitCode !== 0) bits.push(`exit ${t.exitCode}`);
  if (t.health === "unhealthy") bits.push("unhealthy");
  else if (t.health === "starting") bits.push("health starting");
  return bits.length > 0 ? bits.join(" ") : undefined;
}

/** Does anything here deserve the operator's attention? */
export function isTroubled(t: ContainerTelemetry): boolean {
  return t.restarts > 0 || t.oomKilled || t.health === "unhealthy" || (!t.running && t.exitCode !== 0);
}

// ── Recent container stderr ────────────────────────────────────────────────
// `docker compose logs` interleaves every service, prefixed "service-1  | msg".
// The pane wants the few lines that look like a failure, attributed to a lane.
const LOG_LINE = /^(\S+?)\s*\|\s?(.*)$/;
const NOISE = /^\s*$/;
const ERRORISH = /\b(error|fatal|exception|unhandled|refused|denied|timeout|panic|cannot|failed)\b/i;

export const LOG_TAIL_ARGV: readonly string[] = Object.freeze(["logs", "--no-color", "--tail", "200"]);

export interface ContainerLogLine {
  service: string;
  text: string;
}

/**
 * Pick the error-ish tail out of interleaved compose logs.
 *
 * Deliberately NOT a raw tail: the pane is a handful of rows beside a live
 * dashboard, and a raw tail of six chatty services shows whichever lane happens
 * to log most, which is rarely the broken one. Newest last, so the pane reads
 * in the same direction as a terminal.
 */
export function selectContainerErrors(logText: string, max = 5): ContainerLogLine[] {
  const hits: ContainerLogLine[] = [];
  for (const raw of logText.split("\n")) {
    const m = LOG_LINE.exec(raw.trimEnd());
    if (!m) continue;
    const text = (m[2] ?? "").trim();
    if (NOISE.test(text) || !ERRORISH.test(text)) continue;
    hits.push({ service: (m[1] ?? "").replace(/-\d+$/, ""), text });
  }
  return hits.slice(-max);
}

/**
 * One telemetry sweep: which containers this project has, what state they are
 * in, and the error-ish tail of their logs.
 *
 * Takes a `capture` rather than spawning, so the whole sweep — including the
 * two-step "list ids, then inspect them" shape and its empty-project edge —
 * is executable in a unit test. Never throws: it runs on a timer beside a live
 * TUI, so a docker hiccup must degrade to "no sample", not take the boot down.
 */
export function sampleTelemetry(
  capture: (argv: readonly string[]) => string,
): { samples: ContainerTelemetry[]; errors: ContainerLogLine[] } {
  try {
    const ids = capture(["compose", "ps", "-aq"]).split("\n").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return { samples: [], errors: [] };
    const samples = parseTelemetry(capture(["inspect", "--format", TELEMETRY_FORMAT, ...ids]));
    // Only pay for logs when something is actually wrong.
    const errors = samples.some(isTroubled) ? selectContainerErrors(capture(["compose", ...LOG_TAIL_ARGV])) : [];
    return { samples, errors };
  } catch {
    return { samples: [], errors: [] };
  }
}

/**
 * Start the sweep on a timer. 5s rather than the TUI's 250ms repaint: each
 * sweep spawns docker, and Docker's own restart backoff moves on the order of
 * seconds, so a faster poll would cost processes without showing anything new.
 *
 * `unref` so a resident TUI can still exit on its own terms.
 */
export function startTelemetryPolling(opts: {
  repoRoot: string;
  dockerEnv: Record<string, string>;
  onSample: (s: { samples: ContainerTelemetry[]; errors: ContainerLogLine[] }) => void;
  intervalMs?: number;
}): void {
  const capture = (argv: readonly string[]): string =>
    new TextDecoder().decode(
      Bun.spawnSync(["docker", ...argv], { cwd: opts.repoRoot, env: opts.dockerEnv, stdout: "pipe", stderr: "pipe" }).stdout ?? new Uint8Array(),
    );
  const tick = () => opts.onSample(sampleTelemetry(capture));
  tick();
  setInterval(tick, opts.intervalMs ?? 5000).unref?.();
}

/**
 * The Containers pane. Rendered only when there is something to report — a
 * clean boot keeps the screen it always had.
 */
export function renderTelemetryPane(
  samples: readonly ContainerTelemetry[],
  errors: readonly ContainerLogLine[],
  width: number,
): string[] {
  const troubled = samples.filter(isTroubled);
  if (troubled.length === 0 && errors.length === 0) return [];

  const out = [hr(width, "Containers")];
  for (const t of troubled) {
    const detail = telemetryDetail(t) ?? "";
    const glyph = t.running ? color("33", "!") : color("1;31", "✗");
    const where = t.running ? color("2", "running") : color("1;31", "stopped");
    out.push(truncate(`  ${glyph} ${t.service.padEnd(18)} ${where}  ${color("33", detail)}`, width));
  }
  for (const e of errors) {
    out.push(truncate(color("2", `    ${e.service}: `) + color("31", e.text), width));
  }
  return out;
}
