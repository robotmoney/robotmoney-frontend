// The pipeline worker's startup check is HTTP (issue 1034, decision D75).
//
// It used to run preflight checks 1-3 against its own rm_worker credential
// (the retired worker-startup-preflight.test.ts). It holds no credential now,
// so it refuses to start with a database key in its environment, and its check
// is the api's answer to its token: `pipeline_startup: passed` only when the
// api accepts the pipeline-worker token with both rights. The worker entry
// itself is spawned with and without a database key in
// pipeline-worker-api-only.test.ts; this file pins the check's own rules.
import { afterEach, describe, expect, test } from "bun:test";
import { databaseKeysIn, pipelineStartupCheck, PIPELINE_STARTUP_PASSED } from "../src/worker/startup-check.ts";
import { setPipelineTransport, type PipelineTransport } from "../src/worker/pipeline-client.ts";
import { inProcessPipelineTransport } from "./support/pipeline-in-process.ts";

afterEach(() => setPipelineTransport(inProcessPipelineTransport));

const answering = (status: number, body: unknown): PipelineTransport => async () => ({
  status,
  text: JSON.stringify(body),
  retryAfter: null,
});

describe("the database keys the worker refuses to start with", () => {
  test("names every non-empty database key, and nothing else", () => {
    expect(
      databaseKeysIn({
        DATABASE_URL: "postgres://x",
        WORKER_DATABASE_URL: "postgres://y",
        PREFLIGHT_DATABASE_URL: "postgres://z",
        PGPASSWORD: "p",
        PGHOST: "h",
        PIPELINE_API_URL: "http://api:8787",
        PIPELINE_TOKEN_FILE: "/run/rm-token/token",
        PG_POOL_MAX: "2",
      }),
    ).toEqual(["DATABASE_URL", "PGHOST", "PGPASSWORD", "PREFLIGHT_DATABASE_URL", "WORKER_DATABASE_URL"]);
  });

  test("an empty value is no key", () => {
    expect(databaseKeysIn({ DATABASE_URL: "", WORKER_DATABASE_URL: "  " })).toEqual([]);
  });
});

describe("the HTTP startup check", () => {
  test("passes when the api answers for the pipeline-worker holder with both rights", async () => {
    setPipelineTransport(answering(200, { holder: "pipeline-worker", rights: ["pipeline_queue", "pipeline_ingest"] }));
    expect(await pipelineStartupCheck({ apiHealthUrl: null })).toEqual({ passed: true, line: PIPELINE_STARTUP_PASSED });
  });

  test("refuses a token the api does not accept, naming the refusal", async () => {
    setPipelineTransport(answering(401, { error: "unauthorized" }));
    const out = await pipelineStartupCheck({ apiHealthUrl: null });
    expect(out.passed).toBe(false);
    expect(out.line).toMatch(/^pipeline_startup: refused: .*HTTP 401 — unauthorized$/);
  });

  test("refuses another holder's token, and a token missing a right", async () => {
    setPipelineTransport(answering(200, { holder: "analytics-producer", rights: ["pipeline_queue", "pipeline_ingest"] }));
    expect((await pipelineStartupCheck({ apiHealthUrl: null })).line).toBe(
      "pipeline_startup: refused: the token belongs to analytics-producer, not pipeline-worker",
    );
    setPipelineTransport(answering(200, { holder: "pipeline-worker", rights: ["pipeline_queue"] }));
    expect((await pipelineStartupCheck({ apiHealthUrl: null })).line).toBe("pipeline_startup: refused: the token lacks pipeline_ingest");
  });

  test("waits for an api that does not answer yet, rather than refusing", async () => {
    let calls = 0;
    const prev = process.env.PIPELINE_RETRY_DEADLINE_MS;
    process.env.PIPELINE_RETRY_DEADLINE_MS = "0";
    setPipelineTransport(async () => {
      calls++;
      if (calls < 3) throw new Error("Unable to connect");
      return { status: 200, text: JSON.stringify({ holder: "pipeline-worker", rights: ["pipeline_queue", "pipeline_ingest"] }), retryAfter: null };
    });
    try {
      expect((await pipelineStartupCheck({ apiHealthUrl: null })).passed).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PIPELINE_RETRY_DEADLINE_MS;
      else process.env.PIPELINE_RETRY_DEADLINE_MS = prev;
    }
    expect(calls).toBe(3);
  });
});
