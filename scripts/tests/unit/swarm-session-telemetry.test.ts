import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createOnboardingTelemetry } from "../../lib/onboarding-telemetry.ts";
import {
  createSwarmSessionArtifactWriter,
  projectContainerInspect,
} from "../../lib/swarm/telemetry.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("swarm session diagnostic artifacts", () => {
  test("persist without a TUI callback, stay owner-only, bounded, and redact secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "swarm-session-telemetry-"));
    roots.push(root);
    const secret = "sk-planted-secret-123456789";
    const writer = createSwarmSessionArtifactWriter({
      repoRoot: root,
      composeProject: "rm_demo_stack_x",
      sessionId: "42",
      memberId: "athena",
      runId: "athena-s42-test",
      model: "opencode/deepseek-v4-flash",
      timeoutMs: 300_000,
      redactions: [{ value: secret, placeholder: "<OPENCODE_API_KEY redacted>" }],
    });
    const telemetry = createOnboardingTelemetry(
      { composeProject: "rm_demo_stack_x", runId: "athena-s42-test", model: "opencode/deepseek-v4-flash" },
      writer.sink,
      [{ value: secret, placeholder: "<OPENCODE_API_KEY redacted>" }],
    );
    telemetry.emit({ source: "agent", stream: "stdout", message: `RM_TELEMETRY {"milestone":"cli_spawned","apiKey":"${secret}"}` });
    telemetry.emit({ source: "agent", stream: "stderr", message: `Authorization: Bearer ${secret}` });
    for (let i = 0; i < 40; i++) telemetry.emit({ source: "agent", stream: "stdout", message: "💸".repeat(6000) });
    writer.finish({ error: `api_key=${secret}` });

    expect(statSync(writer.directory).mode & 0o777).toBe(0o700);
    for (const file of ["manifest.json", "events.ndjson", "stdout.log", "stderr.log", "result.json"]) {
      const path = join(writer.directory, file);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8")).not.toContain(secret);
    }
    expect(Buffer.byteLength(readFileSync(join(writer.directory, "stdout.log"), "utf8"), "utf8")).toBeLessThanOrEqual(64 * 1024);
    const events = readFileSync(join(writer.directory, "events.ndjson"), "utf8");
    expect(Buffer.byteLength(events, "utf8")).toBeLessThanOrEqual(512 * 1024);
    expect(events).toContain('"truncated":true');
    for (const line of events.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    const manifest = JSON.parse(readFileSync(join(writer.directory, "manifest.json"), "utf8"));
    expect(manifest.model).toBe("opencode/deepseek-v4-flash");
    expect(writer.directory).toContain("/.agents/swarm-sessions/rm_demo_stack_x/42/athena/athena-s42-test");
  });

  test("host-controlled path segments cannot traverse outside the artifact root", () => {
    const root = mkdtempSync(join(tmpdir(), "swarm-session-paths-"));
    roots.push(root);
    const artifactRoot = resolve(root, ".agents", "swarm-sessions");
    const writer = createSwarmSessionArtifactWriter({
      repoRoot: root,
      composeProject: "..",
      sessionId: ".",
      memberId: "../../outside",
      runId: "a/../../../escape",
      model: "opencode/deepseek-v4-flash",
      timeoutMs: 1,
    });
    expect(writer.directory.startsWith(`${artifactRoot}${sep}`)).toBe(true);
    expect(writer.directory).not.toContain(`${sep}..${sep}`);
    expect(writer.directory).not.toContain(`${sep}.${sep}`);
    expect(writer.directory).not.toContain(`${root}${sep}outside`);
  });

  test("Docker inspect is reduced to an allowlist with no env or labels", () => {
    const projected = projectContainerInspect(JSON.stringify([{
      State: {
        Status: "exited", ExitCode: 137, OOMKilled: true, Error: "boom",
        StartedAt: "2026-08-05T00:00:00Z", FinishedAt: "2026-08-05T00:05:00Z",
      },
      Config: { Image: "robotmoney-member-agent:latest", Env: ["OPENCODE_API_KEY=secret"] },
      Labels: { secret: "value" },
    }]));
    expect(projected).toEqual({
      status: "exited", exitCode: 137, oomKilled: true, error: "boom",
      startedAt: "2026-08-05T00:00:00Z", finishedAt: "2026-08-05T00:05:00Z",
      image: "robotmoney-member-agent:latest",
    });
    expect(JSON.stringify(projected)).not.toContain("OPENCODE_API_KEY");
    expect(JSON.stringify(projected)).not.toContain("Labels");
  });
});
