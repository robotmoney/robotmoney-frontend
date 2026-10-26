// V01-archive-integrity (PR 1461): an archive's identity is its content, never
// the gzip encoder or the runtime. For a sealed backup's record and its
// smallest archive file the check fetches the route twice, once asking for
// gzip and once for identity, and requires:
//   - X-Content-SHA256 equals the sha256 of the uncompressed bytes (for a
//     `.csv.gz` file, the bytes inside the gzip: the record's `sha256_raw`);
//   - the ETag is that hash, quoted;
//   - both encodings answer the same ETag and the same X-Content-SHA256.
// Reads only: GETs of the public archive routes.
import { gunzipSync } from "node:zlib";
import { getWithRetry, PUBLIC_API, realNet, sha256Hex, type Net } from "../../public-analytics-read.ts";
import type { VersionCheck } from "../../version-check.ts";

export interface Sample {
  readonly path: string;
  readonly encoding: "gzip" | "identity";
  readonly status: number;
  readonly etag: string | null;
  readonly xsha: string | null;
  /** sha256 of the uncompressed bytes the client received, or null when none came. */
  readonly actualSha: string | null;
}

/** PURE. Every way the samples show an archive's identity is not its content. */
export function integrityProblems(samples: readonly Sample[], recorded: Readonly<Record<string, string>> = {}): string[] {
  const out: string[] = [];
  if (samples.length === 0) out.push("no archive was fetched");
  for (const s of samples) {
    const at = `${s.path} (${s.encoding})`;
    if (s.status !== 200) { out.push(`${at} answered ${s.status}, not 200`); continue; }
    if (s.xsha === null) out.push(`${at} carries no X-Content-SHA256`);
    else if (s.xsha !== s.actualSha) out.push(`${at}: X-Content-SHA256 is ${s.xsha}, the uncompressed bytes hash to ${s.actualSha}`);
    if (s.etag !== `"${s.actualSha}"`) out.push(`${at}: ETag is ${s.etag}, expected "${s.actualSha}" (the sha256 of the uncompressed bytes)`);
    const want = recorded[s.path];
    if (want !== undefined && s.xsha !== want) out.push(`${at}: X-Content-SHA256 ${s.xsha} is not the record's sha256_raw ${want}`);
  }
  for (const path of new Set(samples.map((s) => s.path))) {
    const [g, i] = ["gzip", "identity"].map((e) => samples.find((s) => s.path === path && s.encoding === e));
    if (g && i && g.status === 200 && i.status === 200 && (g.etag !== i.etag || g.xsha !== i.xsha)) {
      out.push(`${path}: gzip answered ETag ${g.etag} / ${g.xsha}, identity answered ${i.etag} / ${i.xsha}; the identity of an archive must not depend on the encoding asked for`);
    }
  }
  return out;
}

async function sample(net: Net, path: string, encoding: "gzip" | "identity"): Promise<Sample> {
  const res = await getWithRetry(net, `${PUBLIC_API}/archive/${path}`, { headers: { "Accept-Encoding": encoding } });
  let actualSha: string | null = null;
  if (res.status === 200) {
    // fetch has already undone a Content-Encoding; a `.csv.gz` file is the archive itself, whose content is inside the gzip.
    const body = new Uint8Array(await res.arrayBuffer());
    actualSha = sha256Hex(path.endsWith(".gz") ? gunzipSync(body) : body);
  }
  return { path, encoding, status: res.status, etag: res.headers.get("etag"), xsha: res.headers.get("x-content-sha256"), actualSha };
}

/** The samples of the first backup's record and its smallest file, both encodings each. */
export async function archiveSamples(net: Net): Promise<{ samples: Sample[]; recorded: Record<string, string>; problems: string[] }> {
  const list = await getWithRetry(net, `${PUBLIC_API}/archive/backups?limit=1`);
  if (list.status !== 200) return { samples: [], recorded: {}, problems: [`GET ${PUBLIC_API}/archive/backups answered ${list.status}`] };
  const record = ((await list.json()) as { backups?: { record?: string }[] }).backups?.[0]?.record;
  if (typeof record !== "string" || !/^csv\/[A-Za-z0-9._-]+\/backup\.json$/.test(record)) return { samples: [], recorded: {}, problems: ["the archive lists no sealed backup"] };
  const recordRes = await getWithRetry(net, `${PUBLIC_API}/archive/${record}`);
  if (recordRes.status !== 200) return { samples: [], recorded: {}, problems: [`GET ${record} answered ${recordRes.status}`] };
  const body = (await recordRes.json()) as { append_only?: Record<string, { files?: { path: string; bytes_raw: number; sha256_raw: string }[] }> };
  const files = Object.values(body.append_only ?? {}).flatMap((t) => t.files ?? []).filter((f) => /^csv\/[A-Za-z0-9._\/-]+$/.test(f.path) && !f.path.includes(".."));
  const smallest = files.sort((a, b) => a.bytes_raw - b.bytes_raw)[0];
  const paths = [record, ...(smallest ? [smallest.path] : [])];
  const samples: Sample[] = [];
  for (const p of paths) for (const e of ["gzip", "identity"] as const) samples.push(await sample(net, p, e));
  return { samples, recorded: smallest ? { [smallest.path]: smallest.sha256_raw } : {}, problems: smallest ? [] : [`${record} lists no archive file`] };
}

export default (async (ctx) => {
  const { samples, recorded, problems } = await archiveSamples(realNet(ctx.origin));
  return { found: { samples }, problems: [...problems, ...(problems.length === 0 ? integrityProblems(samples, recorded) : [])] };
}) satisfies VersionCheck;
