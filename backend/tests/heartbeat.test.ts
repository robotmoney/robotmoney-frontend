// Liveness heartbeat semantics (src/ops/heartbeat.ts) — the comparator the
// worker/producer healthchecks in docker-compose.yml are built on.
//
// These cases pin the two properties the whole design rests on:
//   - a record carries its OWN budget, so an idle lane (seconds) and a lane
//     executing a job (minutes) can report through one comparator;
//   - anything that is not a fresh, parseable record with a live budget is
//     UNHEALTHY — a missing file, a truncated write, a record past its deadline.
// Runs in the required backend-integration job.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkHeartbeatFile,
  evaluateHeartbeat,
  heartbeatPath,
  resetHeartbeatWriter,
  writeHeartbeat,
  DEFAULT_HEARTBEAT_PATH,
} from "../src/ops/heartbeat.ts";

let dir: string;
let path: string;

beforeEach(async () => {
  resetHeartbeatWriter();
  dir = await mkdtemp(join(tmpdir(), "rm-heartbeat-"));
  path = join(dir, "heartbeat");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

test("a fresh record inside its budget is healthy; the same record past it is not", () => {
  const rec = JSON.stringify({ ts: 1_000_000, staleAfterMs: 60_000, phase: "idle", writer: "swarm-1" });

  expect(evaluateHeartbeat(rec, 1_030_000).healthy).toBe(true); // 30s old, 60s budget
  expect(evaluateHeartbeat(rec, 1_059_999).healthy).toBe(true); // just inside
  expect(evaluateHeartbeat(rec, 1_060_001).healthy).toBe(false); // just past
});

test("the budget travels WITH the record, so idle and busy resolve differently at the same age", () => {
  const at = (staleAfterMs: number, phase: string) => JSON.stringify({ ts: 0, staleAfterMs, phase });
  const fiveMinutes = 300_000;

  // Same age, opposite verdicts — this is why the writer, not the healthcheck,
  // owns the threshold.
  expect(evaluateHeartbeat(at(60_000, "idle"), fiveMinutes).healthy).toBe(false);
  expect(evaluateHeartbeat(at(900_000, "busy"), fiveMinutes).healthy).toBe(true);
});

test("a stale verdict names the writer, the phase and both durations", () => {
  const rec = JSON.stringify({
    ts: 0, staleAfterMs: 60_000, phase: "busy", writer: "swarm-7", detail: "job 41 (swarm.session_open)",
  });

  const { healthy, reason } = evaluateHeartbeat(rec, 200_000);

  expect(healthy).toBe(false);
  // An operator reading `docker inspect` must learn WHY, not just that it is red.
  expect(reason).toContain("200s");
  expect(reason).toContain("60s");
  expect(reason).toContain("swarm-7");
  expect(reason).toContain("job 41 (swarm.session_open)");
});

test("anything that is not a usable record is unhealthy, never silently tolerated", () => {
  const now = 1_000;
  expect(evaluateHeartbeat(null, now).healthy).toBe(false); // never written
  expect(evaluateHeartbeat("", now).healthy).toBe(false);
  expect(evaluateHeartbeat('{"ts":123,"staleAfter', now).healthy).toBe(false); // torn write
  expect(evaluateHeartbeat('{"staleAfterMs":60000}', now).healthy).toBe(false); // no ts
  expect(evaluateHeartbeat('{"ts":0}', now).healthy).toBe(false); // no budget
  expect(evaluateHeartbeat('{"ts":0,"staleAfterMs":0}', now).healthy).toBe(false); // budget of zero
  expect(evaluateHeartbeat('{"ts":"soon","staleAfterMs":10}', now).healthy).toBe(false);
});

test("a clock that runs backwards reads as healthy, not as a stall", () => {
  // A timestamp from the future is a clock artifact. Reporting a stall for it
  // would be a false red on every container whose host clock steps.
  expect(evaluateHeartbeat(JSON.stringify({ ts: 5_000, staleAfterMs: 1_000, phase: "idle" }), 1_000).healthy).toBe(true);
});

test("checkHeartbeatFile round-trips a real written record and ages out of it", async () => {
  await writeHeartbeat({ phase: "idle", staleAfterMs: 30_000, writer: "swarm-1" }, { path });

  expect((await checkHeartbeatFile(path)).healthy).toBe(true);
  // Same file, evaluated from a clock 31s later: no rewriting, no sleeping.
  expect((await checkHeartbeatFile(path, Date.now() + 31_000)).healthy).toBe(false);
});

test("a missing file is unhealthy and says so — the loop has never reported", async () => {
  const verdict = await checkHeartbeatFile(join(dir, "never-written"));

  expect(verdict.healthy).toBe(false);
  expect(verdict.reason).toContain("no heartbeat file");
});

test("a torn read is impossible: the record is renamed into place, never written in place", async () => {
  // Plant a full record, then write 200 more while a reader polls. Every read
  // must parse — a non-atomic writer would eventually hand back a half file.
  await writeHeartbeat({ phase: "idle", staleAfterMs: 60_000, writer: "swarm-1" }, { path });
  let reads = 0;
  let torn = 0;
  const reader = (async () => {
    while (reads < 200) {
      const raw = await Bun.file(path).text();
      reads++;
      try { JSON.parse(raw); } catch { torn++; }
    }
  })();

  for (let i = 0; i < 200; i++) {
    resetHeartbeatWriter(); // defeat write coalescing so every call really writes
    await writeHeartbeat({ phase: "idle", staleAfterMs: 60_000, writer: `swarm-${i}`, detail: "x".repeat(i * 20) }, { path });
  }
  await reader;

  expect(torn).toBe(0);
  expect(reads).toBe(200);
});

test("writes to one path are serialized, so a late 'busy' cannot outlive the 'idle' that followed it", async () => {
  // The drain loop records 'busy' WITHOUT awaiting (it must not delay the job it
  // just claimed) and records 'idle' when the job returns. For a fast job those
  // overlap. If the busy write landed last, a finished lane would advertise the
  // 15-minute job budget and mask a real stall for that long.
  const busy = writeHeartbeat({ phase: "busy", staleAfterMs: 900_000, writer: "swarm-1" }, { path });
  const idle = writeHeartbeat({ phase: "idle", staleAfterMs: 60_000, writer: "swarm-1" }, { path });
  await Promise.all([busy, idle]);

  const rec = JSON.parse(await Bun.file(path).text()) as { phase: string; staleAfterMs: number };
  expect(rec.phase).toBe("idle");
  expect(rec.staleAfterMs).toBe(60_000);
});

test("the default path is the one the container healthcheck reads, and HEARTBEAT_FILE overrides it", () => {
  expect(heartbeatPath({})).toBe(DEFAULT_HEARTBEAT_PATH);
  expect(heartbeatPath({ HEARTBEAT_FILE: "" })).toBe(DEFAULT_HEARTBEAT_PATH); // blank is not a path
  expect(heartbeatPath({ HEARTBEAT_FILE: "/var/run/hb" })).toBe("/var/run/hb");
});

test("a heartbeat that cannot be written does not take down the loop it observes", async () => {
  // The directory does not exist. writeHeartbeat must swallow it: the loop's job
  // is the work, and the resulting staleness is already the correct signal.
  await writeHeartbeat({ phase: "idle", staleAfterMs: 1_000, writer: "swarm-1" }, { path: "/nonexistent-dir-xyz/heartbeat" });

  expect((await checkHeartbeatFile("/nonexistent-dir-xyz/heartbeat")).healthy).toBe(false);
});
