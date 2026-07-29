import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyOutcome, type ClassifiableRun } from "../../agent/classify-outcome.ts";
import {
  createOnboardingArtifactWriter,
  createOnboardingTelemetry,
  drainRedactedStream,
  redactTelemetryText,
  startComposeServiceLogFollower,
  type LogFollowerProcess,
  type OnboardingEvent,
} from "../../lib/onboarding-telemetry.ts";

const encoder = new TextEncoder();

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function controlledStream(): {
  stream: ReadableStream<Uint8Array>;
  write(value: string): void;
  close(): void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  return {
    stream: new ReadableStream({ start(c) { controller = c; } }),
    write(value) { controller.enqueue(encoder.encode(value)); },
    close() { controller.close(); },
  };
}

describe("onboarding telemetry stream", () => {
  test("emits a live record before the child pipe exits", async () => {
    const pipe = controlledStream();
    const records: string[] = [];
    let finished = false;
    const draining = drainRedactedStream(pipe.stream, [], (record) => records.push(record.message)).then((value) => {
      finished = true;
      return value;
    });

    pipe.write('{"type":"step_start"}\n');
    await Bun.sleep(0);
    expect(records).toEqual(['{"type":"step_start"}']);
    expect(finished).toBe(false);

    pipe.close();
    expect(await draining).toBe('{"type":"step_start"}\n');
  });

  test("shares one monotonic order across interleaved stdout and stderr", async () => {
    const events: OnboardingEvent[] = [];
    const telemetry = createOnboardingTelemetry({ composeProject: "p", runId: "r" }, (event) => events.push(event));
    const stdout = controlledStream();
    const stderr = controlledStream();
    const outDrain = drainRedactedStream(stdout.stream, [], (r) => telemetry.emit({ source: "agent", stream: "stdout", message: r.message }));
    const errDrain = drainRedactedStream(stderr.stream, [], (r) => telemetry.emit({ source: "agent", stream: "stderr", message: r.message }));

    stdout.write("out-1\n");
    await Bun.sleep(0);
    stderr.write("err-1\n");
    await Bun.sleep(0);
    stdout.write("out-2\n");
    stdout.close();
    stderr.close();
    await Promise.all([outDrain, errDrain]);

    expect(events.map((event) => [event.seq, event.stream, event.message])).toEqual([
      [1, "stdout", "out-1"],
      [2, "stderr", "err-1"],
      [3, "stdout", "out-2"],
    ]);
  });

  test("never emits an exact injected secret split across chunks", async () => {
    const secret = "sk-live-very-secret-value";
    const pipe = controlledStream();
    const records: string[] = [];
    const drained = drainRedactedStream(
      pipe.stream,
      [{ value: secret, placeholder: "<OPENCODE_API_KEY redacted>" }],
      (record) => records.push(record.message),
    );

    pipe.write("OPENCODE_API_KEY=sk-live-very-");
    await Bun.sleep(0);
    expect(records).toEqual([]); // partial lines never cross the safety boundary
    pipe.write("secret-value\nordinary evidence\n");
    pipe.close();
    const final = await drained;
    expect(records.join("\n")).not.toContain(secret);
    expect(final).not.toContain(secret);
    expect(final).toContain("<OPENCODE_API_KEY redacted>");
    expect(final).toContain("ordinary evidence");
  });

  test("structurally redacts generated credentials without hiding public evidence", () => {
    const raw = [
      "Authorization: Bearer abc.def.0123456789",
      'claim response {"claimToken":"tok_generated_abcdef123456","memberId":"member-7"}',
      'token claim response {"token":"generated-bearer-without-prefix"}',
      "ADMIN_TOKEN=admin-secret-123456",
      '"analytics_token": "analytics-secret-123456"',
      "RMPC_COMMITTEE_IDENTITY_PASSPHRASE=pass-secret-123456",
      '"privateKey":"base64-private-material"',
      '"keystore":{"ciphertext":"encrypted-but-sensitive"}',
      '"publicKey":"public-ok","signature":"signature-ok"',
    ].join("\n");
    const out = redactTelemetryText(raw);
    for (const secret of [
      "abc.def.0123456789",
      "tok_generated_abcdef123456",
      "generated-bearer-without-prefix",
      "admin-secret-123456",
      "analytics-secret-123456",
      "pass-secret-123456",
      "base64-private-material",
      "encrypted-but-sensitive",
    ]) expect(out).not.toContain(secret);
    expect(out).toContain('"memberId":"member-7"');
    expect(out).toContain('"publicKey":"public-ok"');
    expect(out).toContain('"signature":"signature-ok"');
  });

  test("redacts the real rmpc keystore ciphertext inside JSON-wrapped OpenCode tool output", () => {
    const ciphertext = "base64-encrypted-seed-material";
    const keystore = JSON.stringify({
      version: 1,
      kind: "rmpc-committee-identity-keystore",
      public_key: "public-ok",
      cipher: { salt: "salt-ok", nonce: "nonce-ok", ciphertext },
    });
    const toolEvent = JSON.stringify({ type: "tool_result", part: { output: keystore } });
    const out = redactTelemetryText(toolEvent);
    expect(out).not.toContain(ciphertext);
    expect(out).toContain("<secret redacted>");
    expect(out).toContain("public-ok");
  });

  test("suppresses multiline private-key and keystore bodies before callbacks", async () => {
    const records: string[] = [];
    const raw = [
      '"keystore": {',
      '  "ciphertext": "must-not-escape",',
      "}",
      "-----BEGIN PRIVATE KEY-----",
      "base64-private-body",
      "-----END PRIVATE KEY-----",
      "diagnostic survives",
      "",
    ].join("\n");
    const final = await drainRedactedStream(streamOf(raw), [], (record) => records.push(record.message));
    expect(final).not.toContain("must-not-escape");
    expect(final).not.toContain("base64-private-body");
    expect(records.join("\n")).not.toContain("must-not-escape");
    expect(records.join("\n")).not.toContain("base64-private-body");
    expect(final).toContain("diagnostic survives");
  });

  test("keeps the classifier-compatible final transcript framing and content", async () => {
    const fixture = readFileSync(join(import.meta.dir, "..", "fixtures", "member-agent-navigation-failure.ndjson"), "utf8");
    const stdout = await drainRedactedStream(streamOf(fixture.slice(0, 71), fixture.slice(71)), []);
    const stderr = await drainRedactedStream(streamOf("compose warning\n"), []);
    const streamedTranscript = `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
    const oldTranscript = `--- stdout ---\n${fixture}\n--- stderr ---\ncompose warning\n`;
    const base: ClassifiableRun = {
      memberId: null,
      admitted: false,
      timedOut: false,
      containerExitCode: 0,
      containerLaunched: true,
    };
    expect(streamedTranscript).toBe(oldTranscript);
    expect(classifyOutcome({ ...base, transcript: streamedTranscript })).toBe(classifyOutcome({ ...base, transcript: oldTranscript }));
  });
});

describe("onboarding eval artifacts", () => {
  test("persists the complete owner-only artifact set for success and failure without contact or credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "onboarding-artifacts-test-"));
    try {
      const skill = join(root, "SKILL.md");
      writeFileSync(skill, "# local skill\n");
      for (const [runId, result] of [
        ["success", { admitted: true, memberId: "m1" }],
        ["failure", { admitted: false, error: "navigation failure" }],
      ] as const) {
        const contact = `${runId}-private@example.test`;
        const writer = createOnboardingArtifactWriter({
          repoRoot: root,
          composeProject: "project",
          runId,
          model: "opencode/deepseek-v4-flash",
          contact,
          prompt: `prompt for ${runId}`,
          skillPath: skill,
          timeoutMs: 100,
          pollIntervalMs: 10,
          autoApproveDelayMs: 20,
        });
        const telemetry = createOnboardingTelemetry({ composeProject: "project", runId }, writer.sink);
        telemetry.emit({ source: "agent", stream: "stdout", message: '{"type":"text"}' });
        telemetry.emit({ source: "agent", stream: "stderr", message: "warning" });
        telemetry.emit({ source: "api", stream: "stdout", message: "api-1 | accepted" });
        writer.finish(result);

        expect(readdirSync(writer.directory).sort()).toEqual([
          "agent.stderr.log",
          "agent.stdout.ndjson",
          "events.ndjson",
          "manifest.json",
          "result.json",
          "services.log",
        ]);
        expect(statSync(writer.directory).mode & 0o777).toBe(0o700);
        for (const file of readdirSync(writer.directory)) expect(statSync(join(writer.directory, file)).mode & 0o077).toBe(0);
        const all = readdirSync(writer.directory).map((file) => readFileSync(join(writer.directory, file), "utf8")).join("\n");
        expect(all).not.toContain(contact);
        expect(all).not.toContain("prompt for");
        expect(all).toContain("promptSha256");
        expect(all).toContain("skillSha256");
      }
    } finally {
      chmodSync(root, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Compose service log follower", () => {
  test("streams both services and terminates/drains before cleanup continues", async () => {
    const stdout = controlledStream();
    const stderr = controlledStream();
    let killed = false;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    const fake: LogFollowerProcess = {
      stdout: stdout.stream,
      stderr: stderr.stream,
      exited,
      kill() {
        killed = true;
        stdout.close();
        stderr.close();
        resolveExit(143);
      },
    };
    const events: OnboardingEvent[] = [];
    let followerArgv: string[] = [];
    let followerEnv: Record<string, string> | null = null;
    const telemetry = createOnboardingTelemetry({ composeProject: "p", runId: "r" }, (event) => events.push(event));
    const exactSpawnEnv = { PATH: "/bin", RM_STACK_ENV_CLASS: "local", RM_STACK_ENV_HASH: "abc123" };
    const follower = startComposeServiceLogFollower({
      repoRoot: "/tmp",
      composeProject: "p",
      spawnEnv: exactSpawnEnv,
      telemetry,
      spawn: (argv, options) => {
        followerArgv = argv;
        followerEnv = options.env;
        return fake;
      },
    });
    stdout.write("api-1 | 2026-01-01 accepted application\n");
    stderr.write("postgres-1 | 2026-01-01 checkpoint\n");
    await Bun.sleep(0);
    const stopped = await follower.stop();
    expect(killed).toBe(true);
    expect(stopped.exitCode).toBe(143);
    expect(await follower.stop()).toEqual(stopped); // idempotent cleanup
    expect(events.map((event) => event.source)).toEqual(["api", "postgres"]);
    expect(followerArgv).toContain("--tail=0");
    expect(followerEnv as Record<string, string> | null).toEqual(exactSpawnEnv);
  });
});
