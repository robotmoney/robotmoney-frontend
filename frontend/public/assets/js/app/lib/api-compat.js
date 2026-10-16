// Is the API this page is about to call one it was built for? (D54, issue #1026 W7)
//
// The static website is its own release unit: it ships on its own schedule and
// declares the API versions it accepts as a semver range (frontend/package.json
// `apiRange`, published in the site's own /version.json). The API reports its
// version at GET /api/version. At load, main.js reads both, and when the API is
// outside the range the page shows a reload notice and lib/api.js makes no other
// /api/* call: a tab left open across an API upgrade would otherwise render the
// new API's shapes through the old page's code and show whatever that produces.
//
// IMPORT-FREE, like the rest of the no-build client, so it is served as-is and
// so a unit test can run the matcher under bun
// (scripts/tests/unit/web-client-api-range.test.ts compares it row by row with
// Bun.semver.satisfies, which is what CI and `bun smoke` use).
//
// ONLY THE OPERATORS THE SITE USES: `^`, `~`, `>=`, `>`, `<=`, `<`, `=` and a
// bare exact version, space-separated (all must hold). No `||`, no `x`
// wildcards, no hyphen ranges, no partial versions. scripts/lib/api-range.ts
// holds the same grammar on the Bun side, so CI refuses a range this file
// could not read.
//
// "DON'T KNOW" NEVER BLOCKS. An unreachable /api/version (the api is down, or
// predates the route), a /version.json with no range, or anything unparseable
// is `unknown`, and the page carries on exactly as it did before this check
// existed — the api-unreachable path still owns outages. Only a readable range
// that a readable API version falls outside is `incompatible`.

const NUM = "(?:0|[1-9]\\d*)";
const VERSION_RE = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`);
const COMPARATOR_RE = new RegExp(`^(\\^|~|>=|<=|>|<|=)?(${NUM})\\.(${NUM})\\.(${NUM})$`);

/**
 * @typedef {{ major: number, minor: number, patch: number, prerelease: boolean }} ParsedVersion
 * @typedef {{ op: string, major: number, minor: number, patch: number }} Comparator
 * @typedef {"compatible" | "incompatible" | "unknown"} CompatStatus
 * @typedef {{ status: CompatStatus, api: string | null, range: string | null, reason: string }} CompatResult
 */

/**
 * @param {unknown} version
 * @returns {ParsedVersion | null}
 */
export function parseApiVersion(version) {
  if (typeof version !== "string") return null;
  const m = VERSION_RE.exec(version);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] !== undefined };
}

/**
 * @param {unknown} range
 * @returns {Comparator[] | null}
 */
export function parseApiRange(range) {
  if (typeof range !== "string") return null;
  const parts = range.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") return null;
  /** @type {Comparator[]} */
  const out = [];
  for (const part of parts) {
    const m = COMPARATOR_RE.exec(part);
    if (!m) return null;
    out.push({ op: m[1] ?? "=", major: Number(m[2]), minor: Number(m[3]), patch: Number(m[4]) });
  }
  return out;
}

/**
 * @param {{ major: number, minor: number, patch: number }} a
 * @param {{ major: number, minor: number, patch: number }} b
 * @returns {number}
 */
function compare(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Whether a release version satisfies one comparator.
 *
 * @param {ParsedVersion} v
 * @param {Comparator} c
 * @returns {boolean}
 */
function comparatorHolds(v, c) {
  const at = compare(v, c);
  switch (c.op) {
    case "=": return at === 0;
    case ">=": return at >= 0;
    case ">": return at > 0;
    case "<=": return at <= 0;
    case "<": return at < 0;
    case "~": {
      // ~M.m.p := >=M.m.p <M.(m+1).0
      return at >= 0 && compare(v, { major: c.major, minor: c.minor + 1, patch: 0 }) < 0;
    }
    case "^": {
      // ^M.m.p leaves the left-most non-zero part fixed:
      //   ^1.2.3 := >=1.2.3 <2.0.0   ^0.2.3 := >=0.2.3 <0.3.0   ^0.0.3 := >=0.0.3 <0.0.4
      const upper = c.major > 0 ? { major: c.major + 1, minor: 0, patch: 0 }
        : c.minor > 0 ? { major: 0, minor: c.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: c.patch + 1 };
      return at >= 0 && compare(v, upper) < 0;
    }
    default: return false;
  }
}

/**
 * Does API `version` satisfy the site's `range`?
 *
 * `true` / `false` with node-semver semantics for everything the grammar
 * admits — including that a prerelease version satisfies none of these ranges,
 * since no comparator in the grammar carries a prerelease tag — and `null` when
 * either side is unreadable, which the caller treats as "don't know".
 *
 * @param {unknown} version
 * @param {unknown} range
 * @returns {boolean | null}
 */
export function apiVersionSatisfies(version, range) {
  const v = parseApiVersion(version);
  const comparators = parseApiRange(range);
  if (!v || !comparators) return null;
  if (v.prerelease) return false;
  return comparators.every((c) => comparatorHolds(v, c));
}

/**
 * @param {(input: string, init?: RequestInit) => Promise<Response>} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @returns {Promise<unknown>}
 */
async function readJson(fetchImpl, url, init, timeoutMs) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, { ...init, cache: "no-store", ...(controller ? { signal: controller.signal } : {}) });
    if (!res.ok) return null;
    if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(res.headers.get("content-type") || "")) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read the site's own range and the API's version, in parallel, and say
 * whether they agree. Never throws and never rejects.
 *
 * @param {{
 *   siteVersionUrl: string,
 *   apiVersionUrl: string | null,
 *   fetch?: (input: string, init?: RequestInit) => Promise<Response>,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<CompatResult>}
 */
export async function checkApiCompat({ siteVersionUrl, apiVersionUrl, fetch: fetchImpl, timeoutMs = 5000 }) {
  // Resolved at call time, not import time: the preview wrapper patches the
  // frame's fetch before the page's scripts run.
  const doFetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  if (!apiVersionUrl) return { status: "unknown", api: null, range: null, reason: "no API base URL" };
  const [site, apiBody] = await Promise.all([
    readJson(doFetch, siteVersionUrl, {}, timeoutMs),
    readJson(doFetch, apiVersionUrl, { credentials: "omit" }, timeoutMs),
  ]);
  const range = site && typeof site === "object" && typeof (/** @type {{ apiRange?: unknown }} */ (site)).apiRange === "string"
    ? /** @type {string} */ ((/** @type {{ apiRange: string }} */ (site)).apiRange)
    : null;
  const api = apiBody && typeof apiBody === "object" && typeof (/** @type {{ api?: unknown }} */ (apiBody)).api === "string"
    ? /** @type {string} */ ((/** @type {{ api: string }} */ (apiBody)).api)
    : null;
  if (range === null) return { status: "unknown", api, range, reason: "this site declares no API range" };
  if (api === null) return { status: "unknown", api, range, reason: "the API did not report a version" };
  const ok = apiVersionSatisfies(api, range);
  if (ok === null) return { status: "unknown", api, range, reason: "unreadable version or range" };
  return ok
    ? { status: "compatible", api, range, reason: "in range" }
    : { status: "incompatible", api, range, reason: `API ${api} is outside this page's range ${range}` };
}

export const RELOAD_NOTICE_TEXT =
  "A newer version of this site is available. The page you have open was built for an older API, so it has stopped loading data. Reload to get the current site.";

/**
 * Put the reload notice at the top of the page. Idempotent. Styled through the
 * CSSOM rather than a style attribute, so it renders under the site's CSP.
 *
 * @param {Document} doc
 * @param {{ api: string | null, range: string | null }} detail
 * @returns {HTMLElement}
 */
export function renderReloadNotice(doc, { api, range }) {
  const existing = /** @type {HTMLElement | null} */ (doc.querySelector("[data-api-compat-notice]"));
  if (existing) return existing;

  const notice = doc.createElement("div");
  notice.setAttribute("role", "alert");
  notice.setAttribute("data-api-compat-notice", "");
  notice.className = "api-compat-notice";
  if (api) notice.dataset.api = api;
  if (range) notice.dataset.range = range;
  Object.assign(notice.style, {
    position: "sticky",
    top: "0",
    zIndex: "10000",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    padding: "12px 16px",
    background: "var(--color-surface, #111)",
    color: "var(--color-text, #eee)",
    borderBottom: "1px solid var(--color-warm, #e0a040)",
    font: "14px/1.4 var(--font-sans, system-ui, sans-serif)",
  });

  const text = doc.createElement("p");
  text.textContent = RELOAD_NOTICE_TEXT;
  Object.assign(text.style, { margin: "0" });

  const button = doc.createElement("button");
  button.type = "button";
  button.textContent = "Reload";
  Object.assign(button.style, {
    padding: "6px 14px",
    border: "1px solid var(--color-warm, #e0a040)",
    borderRadius: "var(--radius-pill, 999px)",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
  });
  button.addEventListener("click", () => doc.defaultView?.location.reload());

  notice.append(text, button);
  doc.body.prepend(notice);
  return notice;
}
