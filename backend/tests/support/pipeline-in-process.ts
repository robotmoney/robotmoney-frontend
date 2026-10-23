// The pipeline worker's transport inside the test process (issue 1034).
//
// The worker reaches the database only through /api/pipeline/** now. A test
// that drives a handler, the drain loop or the scheduler in process has no api
// listening, so tests/preload.ts installs this transport: it dispatches each
// request to the api's own pipeline router (api/routes/pipeline.ts
// dispatchPipeline) on the test database, exactly as the HTTP route would after
// authenticating the token. A write that carries an Idempotency-Key (any write
// a handler sends under a claimed job's lease) is fenced and receipted as it is
// over HTTP; a handler a test calls outside any job sends none, and its writes
// run unfenced. A database failure answers 503 and any other error 500, as the
// api does.
//
// The HTTP path itself (the token, the per-token admission gate, the body and
// row limits) is exercised by tests that boot the real api:
// pipeline-worker-api-only, pipeline-ingest-admission, pipeline-ingest-idempotency
// and pipeline-queue-routes.
import { encodePipeline } from "../../src/lib/pipeline-wire.ts";
import type { PipelineTransport } from "../../src/worker/pipeline-client.ts";

export const inProcessPipelineTransport: PipelineTransport = async (path, body, headers) => {
  const { dispatchPipeline, pipelineError } = await import("../../src/api/routes/pipeline.ts");
  const { dbFailureResponse } = await import("../../src/api/db-failure.ts");
  const key = headers["Idempotency-Key"] ?? null;
  try {
    const reply = await dispatchPipeline(path, body, key, { fenced: key !== null });
    return { status: reply.status, text: encodePipeline(reply.body), retryAfter: null };
  } catch (err) {
    const failure = dbFailureResponse(err);
    if (failure) return { status: failure.status, text: await failure.text(), retryAfter: failure.headers.get("Retry-After") };
    const reply = pipelineError(err);
    return { status: reply.status, text: encodePipeline(reply.body), retryAfter: null };
  }
};
