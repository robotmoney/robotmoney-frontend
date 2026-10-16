// Q41-brand-marks/C27-brand-marks (PR 1344): Minds by Animoca Brands wears Animoca's mark, and
// DualMint's new seat keeps DualMint's.
//
// The marks are the site's own: frontend/public/assets/js/app/lib/member-logos.js
// maps a member handle to a curated logo path, and the member pages render it
// through memberLogo(handle). So the check reads what the site serves, not the
// repository: the served member-logos.js maps each handle to its mark, each mark
// answers 200 as the image it claims to be, and each handle is a member the
// database holds (a mark keyed to a handle no member has never shows).
import type { VersionCheck } from "../../version-check.ts";

/** The served module that maps handles to marks. */
export const MEMBER_LOGOS_PATH = "/assets/js/app/lib/member-logos.js";

/** What PR 1344 added: each handle and the mark it must wear. */
export const EXPECTED_MARKS: Readonly<Record<string, string>> = Object.freeze({
  "minds-by-animoca-brands": "/avatars/swarm/animoca-brands.svg",
  "dualmint-2": "/avatars/swarm/dualmint.png",
});

/** PURE. The `"handle": "/path"` and `handle: "/path"` entries of a served member-logos.js. */
export function parseMemberLogos(js: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = /MEMBER_LOGOS\s*=\s*\{([\s\S]*?)\}/.exec(js)?.[1] ?? "";
  for (const m of body.matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$-]*))\s*:\s*"([^"]+)"/g)) out[m[1] ?? m[2]!] = m[3]!;
  return out;
}

/** PURE. Whether a served body is the image kind its path names: an SVG document, or a PNG's signature. */
export function looksLikeImage(path: string, status: number, body: string): boolean {
  if (status !== 200) return false;
  if (path.endsWith(".svg")) return /<svg[\s>]/.test(body.slice(0, 2048));
  if (path.endsWith(".png")) return body.slice(1, 4) === "PNG";
  return body.length > 0;
}

/** PURE. Every reason the marks are not in place. */
export function brandMarkProblems(input: {
  logosStatus: number;
  logos: Record<string, string>;
  assets: ReadonlyArray<{ path: string; ok: boolean; status: number }>;
  handles: ReadonlySet<string>;
}): string[] {
  const out: string[] = [];
  if (input.logosStatus !== 200) out.push(`${MEMBER_LOGOS_PATH} answered ${input.logosStatus}`);
  for (const [handle, mark] of Object.entries(EXPECTED_MARKS)) {
    const served = input.logos[handle];
    if (served !== mark) out.push(`the served member-logos.js maps ${handle} to ${served ?? "nothing"}, not ${mark}`);
    if (!input.handles.has(handle)) out.push(`no member has the handle ${handle}, so its mark never shows`);
  }
  for (const a of input.assets) if (!a.ok) out.push(`${a.path} answered ${a.status}, not the image it names`);
  return out;
}

export default (async (ctx) => {
  const logos = await ctx.http(MEMBER_LOGOS_PATH);
  const parsed = logos.status === 200 ? parseMemberLogos(logos.text) : {};
  const assets: { path: string; ok: boolean; status: number }[] = [];
  for (const path of new Set(Object.values(EXPECTED_MARKS))) {
    const r = await ctx.http(path);
    assets.push({ path, ok: looksLikeImage(path, r.status, r.text), status: r.status });
  }
  const db = await ctx.db();
  const wanted = Object.keys(EXPECTED_MARKS).map((h) => `'${h.replace(/'/g, "''")}'`).join(", ");
  const rows = await db.query<{ handle: string; status: string }>(`SELECT handle, status FROM swarm_members WHERE handle IN (${wanted})`);
  const handles = new Set(rows.map((r) => r.handle));
  return {
    found: {
      served: Object.fromEntries(Object.keys(EXPECTED_MARKS).map((h) => [h, parsed[h] ?? null])),
      assets,
      members: rows,
    },
    problems: brandMarkProblems({ logosStatus: logos.status, logos: parsed, assets, handles }),
  };
}) satisfies VersionCheck;
