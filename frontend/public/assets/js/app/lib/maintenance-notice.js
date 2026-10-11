// Maintenance banner and view (issue 1220, scope item (c)).
//
// GET /api/status/maintenance answers {state, startsAt, expectedEnd, message}
// from the api, or from the maintenance.json website-server serves while the api
// is down. `scheduled` shows a banner with the start and expected end. `active`
// shows a full maintenance view over the page, with the expected end. `none`,
// a failed fetch or an unreadable body shows nothing: "don't know" never blocks.
// Import-free like the rest of the client. Styled through the CSSOM so it
// renders under the site's CSP.

/**
 * @param {unknown} body
 * @returns {{ state: "scheduled" | "active", startsAt: string | null, expectedEnd: string | null, message: string | null } | null}
 */
export function readMaintenance(body) {
  if (!body || typeof body !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (body);
  if (o.state !== "scheduled" && o.state !== "active") return null;
  const str = (v) => (typeof v === "string" && v !== "" ? v : null);
  return { state: o.state, startsAt: str(o.startsAt), expectedEnd: str(o.expectedEnd), message: str(o.message) };
}

function when(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * @param {Document} doc
 * @param {NonNullable<ReturnType<typeof readMaintenance>>} m
 * @returns {HTMLElement}
 */
export function renderMaintenance(doc, m) {
  const existing = /** @type {HTMLElement | null} */ (doc.querySelector("[data-maintenance]"));
  if (existing) existing.remove();
  const active = m.state === "active";
  const el = doc.createElement(active ? "section" : "div");
  el.setAttribute("data-maintenance", m.state);
  el.setAttribute("role", active ? "alert" : "status");
  const start = when(m.startsAt);
  const end = when(m.expectedEnd);
  const text = doc.createElement("p");
  text.style.margin = "0";
  const lead = active
    ? "Robot Money is undergoing scheduled maintenance."
    : `Scheduled maintenance${start ? ` starts ${start}` : ""}.`;
  text.textContent = [lead, end ? `Expected back ${end}.` : null, m.message].filter(Boolean).join(" ");
  const base = { font: "14px/1.4 var(--font-sans, system-ui, sans-serif)", color: "var(--color-text, #eee)", background: "var(--color-surface, #111)" };
  if (active) {
    Object.assign(el.style, base, {
      position: "fixed", inset: "0", zIndex: "10001", display: "grid", placeItems: "center", padding: "24px", textAlign: "center", fontSize: "18px",
    });
  } else {
    Object.assign(el.style, base, {
      position: "sticky", top: "0", zIndex: "9999", padding: "10px 16px", textAlign: "center", borderBottom: "1px solid var(--color-warm, #e0a040)",
    });
  }
  el.append(text);
  doc.body.prepend(el);
  return el;
}

/**
 * Ask the route and show what it says. Never throws.
 *
 * @param {Document} doc
 * @param {string | null} url
 * @param {(input: string, init?: RequestInit) => Promise<Response>} [fetchImpl]
 */
export async function showMaintenance(doc, url, fetchImpl) {
  if (!url) return null;
  try {
    const res = await (fetchImpl ?? ((i, n) => globalThis.fetch(i, n)))(url, { cache: "no-store", credentials: "omit" });
    if (!res.ok) return null;
    const m = readMaintenance(await res.json());
    return m ? renderMaintenance(doc, m) : null;
  } catch {
    return null;
  }
}
