import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  redactTelemetryText,
  type OnboardingEvent,
  type OnboardingEventSink,
  type RedactionSecret,
} from "../onboarding-telemetry.ts";

const STREAM_TAIL_BYTES = 64 * 1024;
const EVENTS_MAX_BYTES = 512 * 1024;
const EVENT_MESSAGE_MAX_BYTES = 32 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function safeSegment(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9_.-]/g, "-");
  return !cleaned || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}

function ownerOnlyDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let tail = decoder.decode(bytes.slice(bytes.byteLength - maxBytes));
  while (encoder.encode(tail).byteLength > maxBytes) tail = tail.slice(1);
  return tail;
}

function utf8Head(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  const marker = "<truncated to UTF-8 byte cap>";
  const markerBytes = encoder.encode(marker);
  let head = decoder.decode(bytes.slice(0, Math.max(0, maxBytes - markerBytes.byteLength))) + marker;
  while (encoder.encode(head).byteLength > maxBytes) head = head.slice(0, -1 - marker.length) + marker;
  return head;
}

function bounded(value: string, redactions: RedactionSecret[] = []): string {
  const safe = redactTelemetryText(value, redactions);
  return utf8Tail(safe, STREAM_TAIL_BYTES);
}

export interface ContainerStateProjection {
  status: string | null;
  exitCode: number | null;
  oomKilled: boolean | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  image: string | null;
}

/** Convert raw Docker inspect JSON into the only fields safe to retain. */
export function projectContainerInspect(raw: string): ContainerStateProjection {
  const value = JSON.parse(raw)?.[0] ?? {};
  const state = value.State ?? {};
  return {
    status: typeof state.Status === "string" ? state.Status : null,
    exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
    oomKilled: typeof state.OOMKilled === "boolean" ? state.OOMKilled : null,
    error: typeof state.Error === "string" ? redactTelemetryText(state.Error).slice(0, 1000) : null,
    startedAt: typeof state.StartedAt === "string" ? state.StartedAt : null,
    finishedAt: typeof state.FinishedAt === "string" ? state.FinishedAt : null,
    image: typeof value?.Config?.Image === "string" ? value.Config.Image : null,
  };
}

export interface SwarmSessionArtifactWriter {
  readonly directory: string;
  readonly sink: OnboardingEventSink;
  captureInspect(containerName: string, env: Record<string, string>): void;
  finish(result: unknown): void;
}

/** Durable diagnostics for one session/member/container attempt. */
export function createSwarmSessionArtifactWriter(input: {
  repoRoot: string;
  composeProject: string;
  sessionId: string;
  memberId: string;
  runId: string;
  model: string;
  timeoutMs: number;
  redactions?: RedactionSecret[];
}): SwarmSessionArtifactWriter {
  const redactions = input.redactions ?? [];
  const artifactRoot = resolve(input.repoRoot, ".agents", "swarm-sessions");
  const directory = resolve(
    artifactRoot,
    safeSegment(input.composeProject),
    safeSegment(input.sessionId),
    safeSegment(input.memberId),
    safeSegment(input.runId),
  );
  if (!directory.startsWith(`${artifactRoot}${sep}`)) {
    throw new Error("swarm telemetry artifact path escaped its .agents/swarm-sessions root");
  }
  ownerOnlyDirectory(directory);
  const paths = {
    manifest: join(directory, "manifest.json"),
    events: join(directory, "events.ndjson"),
    stdout: join(directory, "stdout.log"),
    stderr: join(directory, "stderr.log"),
    inspect: join(directory, "container-inspect.json"),
    result: join(directory, "result.json"),
  };
  for (const path of Object.values(paths)) writeFileSync(path, "", { mode: 0o600 });
  writeFileSync(paths.manifest, JSON.stringify({
    version: 1,
    composeProject: input.composeProject,
    sessionId: input.sessionId,
    memberId: input.memberId,
    runId: input.runId,
    model: input.model,
    timeoutMs: input.timeoutMs,
    startedAt: new Date().toISOString(),
    streamTailBytes: STREAM_TAIL_BYTES,
  }, null, 2) + "\n", { mode: 0o600 });

  let stdout = "";
  let stderr = "";
  let eventLines: string[] = [];
  let eventsTruncated = false;
  const sink = (event: OnboardingEvent) => {
    const safeEvent = {
      ...event,
      message: utf8Head(redactTelemetryText(event.message, redactions), EVENT_MESSAGE_MAX_BYTES),
    };
    eventLines.push(JSON.stringify(safeEvent) + "\n");
    const marker = JSON.stringify({ version: 1, truncated: true, message: `older events dropped to ${EVENTS_MAX_BYTES}-byte cap` }) + "\n";
    while (eventLines.length > 1 && encoder.encode(marker + eventLines.join("")).byteLength > EVENTS_MAX_BYTES) {
      eventLines.shift();
      eventsTruncated = true;
    }
    const eventBody = eventLines.join("");
    writeFileSync(paths.events, eventsTruncated ? marker + eventBody : eventBody, { mode: 0o600 });
    if (event.source === "agent" && event.stream === "stdout") {
      stdout = bounded(`${stdout}${safeEvent.message}\n`, redactions);
      writeFileSync(paths.stdout, stdout, { mode: 0o600 });
    }
    if (event.source === "agent" && event.stream === "stderr") {
      stderr = bounded(`${stderr}${safeEvent.message}\n`, redactions);
      writeFileSync(paths.stderr, stderr, { mode: 0o600 });
    }
  };

  return {
    directory,
    sink,
    captureInspect(containerName, env) {
      const inspected = Bun.spawnSync(["docker", "inspect", "--type", "container", containerName], {
        env,
        stdin: "ignore",
        stderr: "pipe",
        stdout: "pipe",
      });
      const projection = inspected.exitCode === 0
        ? projectContainerInspect(inspected.stdout.toString())
        : { unavailable: true, exitCode: inspected.exitCode, error: bounded(inspected.stderr.toString(), redactions).slice(-1000) };
      writeFileSync(paths.inspect, JSON.stringify(projection, null, 2) + "\n", { mode: 0o600 });
    },
    finish(result) {
      writeFileSync(paths.result, redactTelemetryText(JSON.stringify(result, null, 2), redactions) + "\n", { mode: 0o600 });
    },
  };
}
