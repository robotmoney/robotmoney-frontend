// GA4 is delivered by Zaraz, with no direct Google/GTM script. See the event
// and deployment contract in docs/ops/zaraz-analytics.md. Same-origin delivery
// does not isolate scripts from an existing admin session in this origin.
import { analyticsConfig } from "./analytics-config.js";
import { analyticsEligible, CONSENT_KEY, CONSENT_VERSION, readConsent, pageFields } from "./analytics-policy.js";

/**
 * @typedef {{ APIReady: boolean, purposes: Record<string, unknown>, modal: boolean, set: (choices: Record<string, boolean>) => void }} ZarazConsent
 * @typedef {{ track: (event: string, fields: Record<string, string>) => unknown, set: (key: string, value: Record<string, string>) => void, consent: ZarazConsent }} Zaraz
 * @param {Window & {zaraz?: Zaraz}} win
 * @param {Document} doc
 * @param {{enabled: boolean, purposeId: string}} config
 */
export function createAnalytics(win, doc, config) {
  function savedChoice() {
    try { return readConsent(win.localStorage); } catch { return "unknown"; }
  }
  let choice = savedChoice();
  let rendered = false;
  let revision = 0;
  let sent = -1;
  let loaderStarted = false;
  let failed = false;
  let googleConsentSet = false;
  /** @type {number | undefined} */
  let timer;
  const configured = config.enabled === true && typeof config.purposeId === "string" && /^[a-zA-Z0-9_-]+$/.test(config.purposeId);
  const allowed = () => configured && choice === "accepted" && analyticsEligible(win.location) && !failed;
  const ready = () => win.zaraz?.consent?.APIReady && typeof win.zaraz.track === "function"
    && typeof win.zaraz.set === "function" && typeof win.zaraz.consent.set === "function" && !!win.zaraz.consent.purposes?.[config.purposeId];

  function send() {
    if (!allowed() || !rendered || !ready() || !win.zaraz || sent === revision) return;
    try {
      if (!googleConsentSet) {
        const denied = { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" };
        win.zaraz.set("google_consent_default", denied);
        win.zaraz.set("google_consent_update", { ...denied, analytics_storage: "granted" });
        win.zaraz.consent.set({ [config.purposeId]: true });
        googleConsentSet = true;
      }
      win.zaraz.consent.modal = false;
      sent = revision;
      Promise.resolve(win.zaraz.track("rm_page_view", pageFields(win.location, doc.title))).catch(() => {});
    } catch { failed = true; }
  }

  function load() {
    if (!allowed() || loaderStarted || !rendered) return;
    loaderStarted = true;
    const script = doc.createElement("script");
    script.src = "/cdn-cgi/zaraz/i.js";
    script.referrerPolicy = "origin";
    script.id = "rm-zaraz";
    script.onload = send;
    script.onerror = () => { failed = true; win.clearTimeout(timer); };
    // A missing/blocked Consent API fails closed; no event queue or retry loop.
    timer = win.setTimeout(() => { if (!ready()) failed = true; }, 10000);
    doc.head.appendChild(script);
  }

  function viewChanged() {
    rendered = true;
    revision++;
    load();
    send();
  }

  /** @param {string} value */
  function choose(value) {
    if (!["accepted", "rejected"].includes(value)) return;
    choice = value;
    try { win.localStorage.setItem(CONSENT_KEY, JSON.stringify({ version: CONSENT_VERSION, choice })); }
    catch { /* Current-document consent remains explicit; next load asks again. */ }
    if (choice === "rejected" && loaderStarted) {
      // Removing a script node cannot revoke its code. Discard the document;
      // never call the transport after withdrawal, or replay queued events.
      win.location.reload();
      return;
    }
    load();
    send();
  }

  win.addEventListener("rm:view-changed", viewChanged);
  doc.addEventListener("zarazConsentAPIReady", send);
  win.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== CONSENT_KEY) return;
    choice = savedChoice();
    if (loaderStarted) win.location.reload();
  });
  // BFCache can resurrect a document with old consent; use a clean load.
  win.addEventListener("pageshow", (event) => { if (event.persisted) win.location.reload(); });
  return { choose, getChoice: () => choice, configured, viewChanged };
}

let started = false;
export function startAnalytics() {
  if (started) return;
  started = true;
  const analytics = createAnalytics(window, document, analyticsConfig);
  if (!analytics.configured || !analyticsEligible(window.location)) return;
  const region = document.createElement("section");
  region.className = "analytics-consent";
  region.setAttribute("aria-label", "Analytics preferences");
  region.innerHTML = `<p id="analytics-description">Allow Google Analytics through Cloudflare to measure public page visits? It may use cookies. Your choice does not affect access. <a href="/privacy">Privacy policy</a></p>
    <div><button type="button" data-choice="accepted">Accept analytics</button>
    <button type="button" data-choice="rejected">Reject analytics</button></div>`;
  const preference = document.createElement("button");
  preference.type = "button";
  preference.className = "analytics-preference";
  preference.textContent = "Analytics preferences";
  preference.setAttribute("aria-expanded", "false");
  preference.addEventListener("click", () => {
    region.hidden = !region.hidden;
    preference.setAttribute("aria-expanded", String(!region.hidden));
    if (!region.hidden) region.querySelector("button")?.focus();
  });
  region.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-choice]") : null;
    if (!(button instanceof HTMLButtonElement)) return;
    analytics.choose(button.dataset.choice || "");
    region.hidden = true;
    preference.setAttribute("aria-expanded", "false");
    preference.focus();
  });
  region.hidden = analytics.getChoice() !== "unknown";
  document.body.append(region, preference);
}
