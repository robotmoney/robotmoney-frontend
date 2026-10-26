// Q42-report-bytes-etag/C30-report-bytes-etag (PR 1427): the public reports route serves a run's
// report bytes exactly as stored, with a strong ETag equal to their sha256. For
// the newest published run the check requires: 200; ETag is the quoted sha256 of
// the bytes served; X-Content-SHA256 and the list's `checksum` are that hash;
// the list's `byte_length` is the length; and a request with that ETag as
// If-None-Match answers 304 with no body.
// Reads only: GETs of /reports.
import { getWithRetry, latestReport, listReports, noRunMessage, PUBLIC_API, realNet, sha256Hex, type Net, type ReportRow } from "../../public-analytics-read.ts";
import type { VersionCheck } from "../../version-check.ts";

export interface Served {
  readonly status: number;
  readonly etag: string | null;
  readonly xsha: string | null;
  readonly bytes: Uint8Array | null;
  readonly revalidateStatus: number | null;
}

/** PURE. Why the served report is not its published bytes with their hash as ETag; empty when it is. */
export function reportServeProblems(row: Pick<ReportRow, "run_key" | "checksum" | "byte_length">, served: Served): string[] {
  const at = `${PUBLIC_API}/reports?run=${row.run_key}`;
  if (served.status !== 200 || served.bytes === null) return [`GET ${at} answered ${served.status}, not 200`];
  const out: string[] = [];
  const actual = sha256Hex(served.bytes);
  if (served.etag !== `"${actual}"`) out.push(`${at}: ETag is ${served.etag}, expected "${actual}" (the sha256 of the bytes served)`);
  if (served.xsha !== actual) out.push(`${at}: X-Content-SHA256 is ${served.xsha}, the bytes served hash to ${actual}`);
  if (row.checksum !== actual) out.push(`${at}: the list's checksum ${row.checksum} is not the sha256 of the bytes served (${actual})`);
  if (row.byte_length !== served.bytes.length) out.push(`${at}: the list says ${row.byte_length} bytes, ${served.bytes.length} were served`);
  if (served.revalidateStatus !== 304) out.push(`${at}: If-None-Match with its ETag answered ${served.revalidateStatus}, not 304`);
  return out;
}

export async function reportBytesEtag(net: Net): Promise<{ found: Record<string, unknown>; problems: string[] }> {
  const { reports, problems } = await listReports(net);
  if (problems.length > 0) return { found: {}, problems };
  const row = latestReport(reports);
  if (row === undefined) return { found: {}, problems: [noRunMessage("the report bytes check")] };
  const path = `${PUBLIC_API}/reports?run=${encodeURIComponent(row.run_key)}`;
  const res = await getWithRetry(net, path);
  const bytes = res.status === 200 ? new Uint8Array(await res.arrayBuffer()) : null;
  const etag = res.headers.get("etag");
  const re = etag === null ? null : await getWithRetry(net, path, { headers: { "If-None-Match": etag } });
  const served: Served = { status: res.status, etag, xsha: res.headers.get("x-content-sha256"), bytes, revalidateStatus: re?.status ?? null };
  return { found: { run_key: row.run_key, bytes: bytes?.length ?? null, etag, revalidateStatus: served.revalidateStatus }, problems: reportServeProblems(row, served) };
}

export default ((ctx) => reportBytesEtag(realNet(ctx.origin))) satisfies VersionCheck;
