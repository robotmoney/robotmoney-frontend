// A fake of the public analytics API for the release SDK checks (issue 1476):
// it serves the committed recording of the real archive routes
// (packages/analyst-sdk/tests/fixtures/archive/api-recorded/) with the headers
// the real routes send, a reports list and a report's bytes. Options plant the
// failures the checks must catch.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { sha256Hex, type Net } from "../../../release/public-analytics-read.ts";

export const RECORDING = join(import.meta.dir, "../../../../packages/analyst-sdk/tests/fixtures/archive/api-recorded");
export const RUN_KEY = "0f6b6c1e-6a52-4c39-9f4e-1a2b3c4d5ea2";
export const COMMIT = "a".repeat(40);

export interface FakeOptions {
  /** Published reports: the list rows; empty means the target has none. */
  reports?: { run_key: string; asof: string; bytes: Uint8Array }[];
  /** Plant: answer the archive routes with this status. */
  archiveStatus?: number;
  /** Plant: the ETag is the sha256 of the gzip, not of the content. */
  etagOfGzip?: boolean;
  /** Plant: the ETag differs between gzip and identity. */
  etagByEncoding?: boolean;
  /** Plant: the report's ETag is not its sha256. */
  badReportEtag?: boolean;
  /** Plant: the build identity of the vintages. */
  buildIdentity?: string;
  /** The commit /api/version reports. */
  commit?: string;
  /** Rate limit: refuse with 429 after this many report requests; Infinity never refuses. */
  limitAfter?: number;
  /** Plant: the 429 carries no Retry-After. */
  noRetryAfter?: boolean;
}

/** A Net whose fetch answers from the recording, in process. */
export function fakeNet(opts: FakeOptions = {}): Net & { requests: string[] } {
  const requests: string[] = [];
  let reportRequests = 0;
  const reports = opts.reports ?? [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    requests.push(u.pathname + u.search);
    const p = u.pathname;
    const enc = new Headers(init?.headers).get("accept-encoding") ?? "";
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
    if (p === "/api/version") return json({ api: "x", commit: opts.commit ?? COMMIT });
    const API = "/api/public/analytics";
    if (p.startsWith(`${API}/archive/`)) {
      if (opts.archiveStatus) return json({ error: "x" }, opts.archiveStatus);
      const rel = p.slice(`${API}/archive/`.length);
      const file = join(RECORDING, rel === "backups" ? "backups.json" : rel);
      if (!existsSync(file) || rel.includes("..")) return json({ error: "not found" }, 404);
      const raw = readFileSync(file);
      const content = rel.endsWith(".gz") ? gunzipSync(raw) : raw;
      if (rel === "backups") return json(JSON.parse(raw.toString()), 200);
      const sha = sha256Hex(content);
      const etagSha = opts.etagOfGzip ? sha256Hex(raw) : opts.etagByEncoding && enc.includes("gzip") ? sha256Hex("other") : sha;
      return new Response(raw, { status: 200, headers: { ETag: `"${etagSha}"`, "X-Content-SHA256": sha } });
    }
    if (p === `${API}/reports`) {
      const run = u.searchParams.get("run");
      if (run === null) {
        const rows = reports.map((r, i) => ({ report_id: i + 1, run_key: r.run_key, asof: r.asof, checksum: sha256Hex(r.bytes), byte_length: r.bytes.length, created_at: "2026-10-01T00:00:00Z" }));
        return json({ schemaVersion: 1, limit: 1000, reports: rows, nextCursor: null });
      }
      reportRequests++;
      if (opts.limitAfter !== undefined && reportRequests > opts.limitAfter) {
        return json({ error: "rate limit exceeded" }, 429, opts.noRetryAfter ? {} : { "Retry-After": "17" });
      }
      const r = reports.find((x) => x.run_key === run);
      if (!r) return json({ error: "no published report" }, 404);
      const sha = sha256Hex(r.bytes);
      const etag = opts.badReportEtag ? `"${"0".repeat(64)}"` : `"${sha}"`;
      if (new Headers(init?.headers).get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      return new Response(r.bytes as unknown as BodyInit, { status: 200, headers: { ETag: etag, "X-Content-SHA256": sha } });
    }
    if (p === `${API}/vintages`) {
      const identity = opts.buildIdentity ?? opts.commit ?? COMMIT;
      return json({ schemaVersion: 1, limit: 100, vintages: [{ id: 7, run_key: u.searchParams.get("run_key"), build_identity: identity }, { id: 8, run_key: u.searchParams.get("run_key"), build_identity: identity }], nextCursor: null });
    }
    return json({ error: "not found" }, 404);
  };
  return { origin: "http://fake.invalid", fetch: fetchImpl, sleep: async () => {}, requests };
}

/** A real HTTP server with the same routes, for the README's `curl` fill. Stop it with `.stop(true)`. */
export function fakeServer(opts: FakeOptions = {}) {
  const net = fakeNet(opts);
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const res = await net.fetch(`${net.origin}${new URL(req.url).pathname}${new URL(req.url).search}`, { headers: req.headers });
      return res;
    },
  });
  return { server, origin: `http://127.0.0.1:${server.port}` };
}
