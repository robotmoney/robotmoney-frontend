// The footer's release line (issue 1713): which web release and which platform
// release are live, the web release's commit and that commit's time, e.g.
//   web-0.2.1 · platform-0.9.0 · 3b13bd37 · 2026-11-12 14:03 UTC
//
// The web values come from the site's own /version.json (`version`, `commit`,
// `committedAt`); the platform value is the bare `version` field of GET
// /api/version (issue 1443). That response's `api` field is the CONTRACT
// version, not the platform release, so it is never shown here: until 1443
// ships, the platform slot is a dash. Any missing value is a dash, and a
// prerelease suffix (an internal -rc tag) is never shown.
//
// IMPORT-FREE like the rest of the no-build client; unit-tested under bun in
// scripts/tests/unit/release-identity.test.ts.

export const DASH = "–";
const SEMVER_RE = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/;

/**
 * @param {unknown} v
 * @returns {string | null} the release part of a semver, without any prerelease suffix
 */
function release(v) {
  if (typeof v !== "string") return null;
  const m = SEMVER_RE.exec(v.trim());
  return m ? m[1] : null;
}

/**
 * @param {unknown} at
 * @returns {string | null} "YYYY-MM-DD HH:MM UTC"
 */
function utcMinute(at) {
  if (typeof at !== "string" || at === "") return null;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * @param {unknown} site the parsed /version.json, or null
 * @param {unknown} api the parsed GET /api/version body, or null
 * @returns {string}
 */
export function formatReleaseIdentity(site, api) {
  const s = site && typeof site === "object" ? /** @type {Record<string, unknown>} */ (site) : {};
  const a = api && typeof api === "object" ? /** @type {Record<string, unknown>} */ (api) : {};
  const web = release(s.version);
  const platform = release(a.version);
  const commit = typeof s.commit === "string" && /^[0-9a-f]{7,40}$/i.test(s.commit) ? s.commit.slice(0, 8) : null;
  return [
    web ? `web-${web}` : DASH,
    platform ? `platform-${platform}` : DASH,
    commit ?? DASH,
    utcMinute(s.committedAt) ?? DASH,
  ].join(" · ");
}

/**
 * Fill every `[data-release-identity]` element. Never throws.
 *
 * @param {Document} doc
 * @param {unknown} site
 * @param {unknown} api
 */
export function renderReleaseIdentity(doc, site, api) {
  const text = formatReleaseIdentity(site, api);
  for (const el of doc.querySelectorAll("[data-release-identity]")) el.textContent = text;
}
