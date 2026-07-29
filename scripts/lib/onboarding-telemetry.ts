import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { composeArgs, DEFAULT_COMPOSE_FILES } from "../stack/config.ts";

export type OnboardingEventSource = "harness" | "agent" | "api" | "postgres" | "compose" | "cleanup";
export type OnboardingEventStream = "event" | "stdout" | "stderr";

export interface OnboardingEvent {
  version: 1;
  composeProject: string;
  runId: string;
  attempt: number;
  source: OnboardingEventSource;
  stream: OnboardingEventStream;
  seq: number;
  timestamp: string;
  message: string;
  containerName?: string;
  openCodeSessionId?: string;
  memberId?: string;
  suiteRunId?: string;
  evalId?: string;
  sampleId?: string;
  model?: string;
}

export type OnboardingEventSink = (event: OnboardingEvent) => void;
export type OnboardingEventInput = Omit<
  OnboardingEvent,
  | "version"
  | "composeProject"
  | "runId"
  | "attempt"
  | "seq"
  | "timestamp"
  | "openCodeSessionId"
  | "memberId"
  | "suiteRunId"
  | "evalId"
  | "sampleId"
  | "model"
> & { openCodeSessionId?: string; memberId?: string };

export interface OnboardingTelemetry {
  emit(input: OnboardingEventInput): OnboardingEvent;
  setMemberId(memberId: string | null): void;
  readonly memberId: string | null;
  readonly openCodeSessionId: string | null;
}

const SESSION_ID = /\bses_[A-Za-z0-9_-]{8,}\b/;

export function createOnboardingTelemetry(
  context: {
    composeProject: string;
    runId: string;
    attempt?: number;
    suiteRunId?: string;
    evalId?: string;
    sampleId?: string;
    model?: string;
  },
  sink?: OnboardingEventSink,
  redactions: RedactionSecret[] = [],
): OnboardingTelemetry {
  let seq = 0;
  let memberId: string | null = null;
  let openCodeSessionId: string | null = null;
  return {
    emit(input) {
      // This is the last shared boundary before callback/console/disk. Sources
      // normally redact earlier as well, but a future lifecycle event cannot
      // accidentally bypass structural or caller-known-value scrubbing.
      const message = redactTelemetryText(input.message, redactions);
      const observedSession = input.openCodeSessionId ?? message.match(SESSION_ID)?.[0] ?? null;
      if (observedSession) openCodeSessionId = observedSession;
      if (input.memberId) memberId = input.memberId;
      const event: OnboardingEvent = {
        version: 1,
        composeProject: context.composeProject,
        runId: context.runId,
        attempt: context.attempt ?? 1,
        source: input.source,
        stream: input.stream,
        seq: ++seq,
        timestamp: new Date().toISOString(),
        message,
        ...(input.containerName ? { containerName: input.containerName } : {}),
        ...(openCodeSessionId ? { openCodeSessionId } : {}),
        ...(memberId ? { memberId } : {}),
        ...(context.suiteRunId ? { suiteRunId: context.suiteRunId } : {}),
        ...(context.evalId ? { evalId: context.evalId } : {}),
        ...(context.sampleId ? { sampleId: context.sampleId } : {}),
        ...(context.model ? { model: context.model } : {}),
      };
      sink?.(event);
      return event;
    },
    setMemberId(value) {
      memberId = value;
    },
    get memberId() {
      return memberId;
    },
    get openCodeSessionId() {
      return openCodeSessionId;
    },
  };
}

export interface RedactionSecret {
  value: string | null | undefined;
  placeholder: string;
}

// Generated credentials are not known at process launch, so exact-value
// replacement is followed by structural scrubbing. Public keys and signatures
// are intentionally absent from these field names: they are useful evidence
// and are not credentials.
export function structurallyRedactSecrets(text: string): string {
  return text
    .replace(/-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:ENCRYPTED )?PRIVATE KEY-----/gi, "<private key redacted>")
    .replace(/(\bAuthorization\s*[:=]\s*)(?:Bearer\s+)?(?!<[^>\r\n]+ redacted>)[^\s"',}]+/gi, "$1<authorization redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <token redacted>")
    .replace(/\btok_[A-Za-z0-9_-]{6,}\b/g, "<claim token redacted>")
    .replace(
      /((?:\\?["']?)(?:token|claim[_-]?token|token[_-]?claim|member[_-]?token|admin[_-]?token|analytics[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?key|passphrase|private[_-]?key|secret[_-]?key|keystore|ciphertext)(?:\\?["']?)\s*[:=]\s*)((?:\\?["']))(?!<[^>\r\n]+ redacted>)(.*?)\2/gi,
      "$1$2<secret redacted>$2",
    )
    .replace(
      /(\b(?:CLAIM_TOKEN|ADMIN_TOKEN|ANALYTICS_TOKEN|[A-Z0-9_]*API_KEY|[A-Z0-9_]*PASSPHRASE|PRIVATE_KEY|SECRET_KEY|KEYSTORE)\s*=\s*)(?!<[^>\r\n]+ redacted>)([^\s]+)/g,
      "$1<secret redacted>",
    )
    .replace(/(--(?:claim-token|admin-token|analytics-token|api-key|passphrase|private-key|secret-key)\s+)([^\s]+)/gi, "$1<secret redacted>")
    .replace(/(["']?keystore["']?\s*:\s*)\{[\s\S]*?\}/gi, "$1<keystore redacted>");
}

export function redactTelemetryText(text: string, secrets: RedactionSecret[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret.value || secret.value.length < 8) continue;
    out = out.split(secret.value).join(secret.placeholder);
  }
  return structurallyRedactSecrets(out);
}

export interface RedactedStreamRecord {
  text: string;
  message: string;
}

/**
 * Drain a pipe without buffering the child. Complete lines are redacted and
 * emitted immediately; a partial line is retained until its continuation
 * arrives, so an injected/generated secret split across read chunks can never
 * leak through the callback. The returned string is assembled from those same
 * redacted records and remains byte-compatible with the old final transcript
 * apart from the newly required structural redaction.
 */
export async function drainRedactedStream(
  stream: ReadableStream<Uint8Array>,
  secrets: RedactionSecret[],
  onRecord?: (record: RedactedStreamRecord) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let out = "";
  let inPrivateKey = false;
  let inKeystore = false;

  const consume = (raw: string) => {
    const hasNewline = raw.endsWith("\n");
    let body = hasNewline ? raw.slice(0, -1) : raw;
    if (body.endsWith("\r")) body = body.slice(0, -1);
    if (/-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/i.test(body)) inPrivateKey = true;
    if (!inKeystore && /["']?keystore["']?\s*:\s*\{/.test(body) && !/\}[^}]*$/.test(body)) inKeystore = true;
    let redacted: string;
    if (inKeystore) {
      redacted = /["']?keystore["']?\s*:\s*\{/.test(body) ? "<keystore redacted>" : "";
      if (/\}/.test(body)) inKeystore = false;
    } else if (inPrivateKey) {
      redacted = /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/i.test(body) ? "<private key redacted>" : "";
      if (/-----END (?:ENCRYPTED )?PRIVATE KEY-----/i.test(body)) inPrivateKey = false;
    } else {
      redacted = redactTelemetryText(body, secrets);
    }
    const text = redacted + (hasNewline ? "\n" : "");
    out += text;
    // Suppressed private-key body lines do not become empty telemetry noise.
    if (redacted || (!inPrivateKey && !inKeystore)) onRecord?.({ text, message: redacted });
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline === -1) break;
      const line = pending.slice(0, newline + 1);
      pending = pending.slice(newline + 1);
      consume(line);
    }
  }
  pending += decoder.decode();
  if (pending) consume(pending);
  return out;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface OnboardingArtifactManifestInput {
  repoRoot: string;
  composeProject: string;
  runId: string;
  attempt?: number;
  model: string;
  contact: string;
  prompt: string;
  skillPath: string;
  timeoutMs: number;
  pollIntervalMs: number;
  autoApproveDelayMs: number;
  suiteRunId?: string;
  evalId?: string;
  sampleId?: string;
}

export interface OnboardingArtifactWriter {
  readonly directory: string;
  readonly sink: OnboardingEventSink;
  finish(result: unknown): void;
}

export function createOnboardingArtifactWriter(input: OnboardingArtifactManifestInput): OnboardingArtifactWriter {
  const directory = input.suiteRunId && input.evalId && input.sampleId
    ? join(input.repoRoot, ".agents", "evals", input.suiteRunId, "cases", input.evalId, input.sampleId)
    : join(input.repoRoot, ".agents", "onboarding-evals", input.composeProject, input.runId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const paths = {
    manifest: join(directory, "manifest.json"),
    events: join(directory, "events.ndjson"),
    stdout: join(directory, "agent.stdout.ndjson"),
    stderr: join(directory, "agent.stderr.log"),
    services: join(directory, "services.log"),
    result: join(directory, "result.json"),
  };
  for (const path of Object.values(paths)) writeFileSync(path, "", { mode: 0o600 });
  const skill = readFileSync(input.skillPath);
  writeFileSync(
    paths.manifest,
    JSON.stringify(
      {
        version: 1,
        composeProject: input.composeProject,
        runId: input.runId,
        ...(input.suiteRunId ? { suiteRunId: input.suiteRunId } : {}),
        ...(input.evalId ? { evalId: input.evalId } : {}),
        ...(input.sampleId ? { sampleId: input.sampleId } : {}),
        attempt: input.attempt ?? 1,
        model: input.model,
        startedAt: new Date().toISOString(),
        contactHash: sha256(`${input.runId}\0${input.contact}`),
        promptSha256: sha256(input.prompt),
        skillSha256: sha256(skill),
        limits: {
          timeoutMs: input.timeoutMs,
          pollIntervalMs: input.pollIntervalMs,
          autoApproveDelayMs: input.autoApproveDelayMs,
        },
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );

  const sink: OnboardingEventSink = (event) => {
    const serialized = JSON.stringify(event) + "\n";
    appendFileSync(paths.events, serialized, { mode: 0o600 });
    if (event.source === "agent" && event.stream === "stdout") appendFileSync(paths.stdout, serialized, { mode: 0o600 });
    if (event.source === "agent" && event.stream === "stderr") appendFileSync(paths.stderr, event.message + "\n", { mode: 0o600 });
    if (event.source === "api" || event.source === "postgres" || event.source === "compose") {
      appendFileSync(paths.services, `${event.timestamp} ${event.source}/${event.stream} ${event.message}\n`, { mode: 0o600 });
    }
  };

  return {
    directory,
    sink,
    finish(result) {
      // Synchronous writes are deliberate: when this returns every artifact is
      // durable before the caller starts Compose teardown.
      writeFileSync(paths.result, redactTelemetryText(JSON.stringify(result, null, 2)) + "\n", { mode: 0o600 });
    },
  };
}

export interface LogFollowerProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number): void;
}

export interface ComposeServiceLogFollower {
  stop(): Promise<{ exitCode: number }>;
}

export function startComposeServiceLogFollower(opts: {
  repoRoot: string;
  composeProject: string;
  composeFiles?: string[];
  spawnEnv: Record<string, string>;
  telemetry: OnboardingTelemetry;
  redactions?: RedactionSecret[];
  spawn?: (argv: string[], options: { cwd: string; env: Record<string, string> }) => LogFollowerProcess;
}): ComposeServiceLogFollower {
  const argv = [
    "docker",
    ...composeArgs(opts.composeProject, opts.composeFiles ?? DEFAULT_COMPOSE_FILES),
    "logs",
    "--follow",
    // Attach at the present edge. Without this, Compose replays the entire
    // postgres initialization log and buries the agent/API exchange we are
    // trying to diagnose.
    "--tail=0",
    "--timestamps",
    "--no-color",
    "api",
    "postgres",
  ];
  const process = opts.spawn
    ? opts.spawn(argv, { cwd: opts.repoRoot, env: opts.spawnEnv })
    : (Bun.spawn(argv, {
        cwd: opts.repoRoot,
        env: opts.spawnEnv,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }) as unknown as LogFollowerProcess);

  const emit = (stream: "stdout" | "stderr", message: string) => {
    // Compose prefixes lines as `<service>-N | ...`; retain the full message
    // while using the prefix to normalize the source.
    const source: OnboardingEventSource = /(?:^|[-_])api-\d+\s+\|/.test(message)
      ? "api"
      : /(?:^|[-_])postgres-\d+\s+\|/.test(message)
        ? "postgres"
        : "compose";
    opts.telemetry.emit({ source, stream, message });
  };
  const stdout = drainRedactedStream(process.stdout, opts.redactions ?? [], (r) => emit("stdout", r.message));
  const stderr = drainRedactedStream(process.stderr, opts.redactions ?? [], (r) => emit("stderr", r.message));
  let stopped: Promise<{ exitCode: number }> | null = null;
  return {
    stop() {
      if (stopped) return stopped;
      stopped = (async () => {
        try {
          process.kill();
        } catch {
          // Already exited is a successful follower termination.
        }
        const [exitCode] = await Promise.all([process.exited, stdout, stderr]);
        return { exitCode };
      })();
      return stopped;
    },
  };
}
