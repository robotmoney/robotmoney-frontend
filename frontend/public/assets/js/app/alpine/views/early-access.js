// @ts-nocheck: buildless Alpine factory for the early-access page
// (/early-access, RM-189): one form that registers interest in depositing
// before the vault opens to outside depositors, carrying a referral code: the
// one the visitor types, or the one their link brought (lib/referral.js), which
// fills the field in.
//
// The options are static HTML in views/early-access.html, so a reader without
// JavaScript sees them; their `value`s are what is stored. Ranges, not
// amounts: they get answered. The wallet is optional (a treasury may deposit
// from a Safe it has not set up yet) and, when given, EIP-55 checked and sent
// checksummed.
import { parseEvmAddress } from "../../lib/evm-address.js";
import { referralCode, clearReferral } from "../../lib/referral.js";

// Sign-ups go to a private Google Sheet through an Apps Script web app, not
// to our API (RM-189: no backend work for launch). The script, its setup and
// the sheet's columns are in docs/ops/early-access-sheet.md. The URL is public
// by nature: whoever loads the page can read it, and it can only append a
// row (the script has no read path). A send without it fails visibly.
export const EARLY_ACCESS_URL = "https://script.google.com/macros/s/AKfycbxzDpdBKN0YLyCVZPnrgPQTY7Ux92At-CC-lAY65gM3yidHaFsFfQGMHFXBwkM5TvyZQg/exec";

// Cloudflare Turnstile, against junk sign-ups. The site key is public; the
// secret lives in the Apps Script's properties, which checks each token before
// it writes a row. Empty means off: no script is loaded and no token is sent.
export const TURNSTILE_SITE_KEY = "";
const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=rmTurnstileReady";
// How long a send waits for a token before asking the visitor to finish the check.
const CHALLENGE_WAIT_MS = 8000;

let turnstileLoad = null;
/** Cloudflare's script, loaded once per page; resolves to window.turnstile. */
function loadTurnstile() {
  if (!turnstileLoad) {
    turnstileLoad = new Promise((resolve, reject) => {
      globalThis.rmTurnstileReady = () => resolve(globalThis.turnstile);
      const el = document.createElement("script");
      el.src = TURNSTILE_SRC;
      el.async = true;
      el.onerror = () => { turnstileLoad = null; reject(new Error("turnstile did not load")); };
      document.head.appendChild(el);
    });
  }
  return turnstileLoad;
}

// Sign-ups from anywhere but the production site say where they came from, so
// a test from a preview or staging is told apart in the sheet.
const CANONICAL_HOST = "robotmoney.network";
export const sourceFor = (host) => (!host || host === CANONICAL_HOST ? "early-access" : `early-access@${host}`);

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/**
 * A Telegram or X handle as `@name`, or null. A pasted profile link
 * (t.me/name, x.com/name, twitter.com/name) is taken for its handle. Both
 * services allow letters, digits and underscores, up to 32 characters.
 */
export function normalizeHandle(input) {
  let s = String(input ?? "").trim();
  s = s.replace(/^(https?:\/\/)?(www\.)?(t\.me|telegram\.me|x\.com|twitter\.com)\//i, "").replace(/[/?#].*$/, "");
  s = s.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,32}$/.test(s) ? `@${s}` : null;
}

/**
 * Field errors for a draft, keyed by field; empty when it can be sent.
 * @returns {Record<string, string>}
 */
export function validateEarlyAccess(d) {
  const errors = {};
  const handle = d.handle.trim();
  if (!handle) errors.handle = "Enter a Telegram or X handle.";
  else if (!normalizeHandle(handle)) errors.handle = "Use the handle itself, like @name.";
  if (d.email.trim() && !isEmail(d.email.trim())) errors.email = "This is not an email address.";
  if (d.wallet.trim() && !parseEvmAddress(d.wallet)) {
    errors.wallet = /^0x[0-9a-fA-F]{40}$/.test(d.wallet.trim())
      ? "The checksum does not match. Copy the address again from your wallet."
      : "An EVM address is 0x followed by 40 hex characters.";
  }
  if (!d.businessType) errors.businessType = "Choose one.";
  if (!d.intendedDeposit) errors.intendedDeposit = "Choose one.";
  if (!d.nonStableShare) errors.nonStableShare = "Choose one.";
  return errors;
}

/**
 * Send to the sheet. text/plain keeps it a simple request, with no preflight,
 * which an Apps Script web app cannot answer. The reply is { ok: boolean }.
 */
export async function sendEarlyAccess(payload, url = EARLY_ACCESS_URL, fetchFn = globalThis.fetch) {
  if (!url) throw new Error("early access is not connected");
  const res = await fetchFn(url, { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload) });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok !== true) throw new Error(body?.error || `send failed (${res.status})`);
}

/**
 * The request body: trimmed, the wallet checksummed, blanks as null. The
 * referral code goes as typed: the report side judges it, as it does a link's.
 */
export function earlyAccessPayload(d, host) {
  return {
    handle: normalizeHandle(d.handle),
    email: d.email.trim() || null,
    wallet: d.wallet.trim() ? parseEvmAddress(d.wallet) : null,
    businessType: d.businessType,
    intendedDeposit: d.intendedDeposit,
    nonStableShare: d.nonStableShare,
    referralCode: d.referralCode?.trim() || null,
    source: sourceFor(host),
    // The honeypot. People never see the field; a bot that fills it is dropped.
    website: d.website || "",
  };
}

export function registerEarlyAccessForm(Alpine) {
  Alpine.data("earlyAccessForm", () => ({
    draft: { handle: "", email: "", wallet: "", referralCode: "", businessType: "", intendedDeposit: "", nonStableShare: "", website: "" },
    errors: {},
    // Errors show once a send has been tried, then follow every edit.
    tried: false,
    sending: false,
    sent: false,
    failed: false,
    sentHandle: "",
    // Turnstile: the current token, and whether a send gave up waiting for one.
    challengeToken: "",
    challengeMissing: false,
    widgetId: null,

    async init() {
      this.draft.referralCode = referralCode() ?? "";
      if (!TURNSTILE_SITE_KEY) return;
      try {
        const turnstile = await loadTurnstile();
        this.widgetId = turnstile.render(this.$refs.challenge, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: "dark",
          appearance: "interaction-only",
          callback: (token) => { this.challengeToken = token; this.challengeMissing = false; },
          "expired-callback": () => { this.challengeToken = ""; },
          "error-callback": () => { this.challengeToken = ""; },
        });
      } catch { /* the send reports it: no token, so the visitor is asked to retry */ }
    },
    destroy() {
      if (this.widgetId !== null) globalThis.turnstile?.remove(this.widgetId);
    },
    // Resolves to a token, waiting briefly for a check still in progress.
    async challenge() {
      if (!TURNSTILE_SITE_KEY) return null;
      const until = Date.now() + CHALLENGE_WAIT_MS;
      while (!this.challengeToken && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
      return this.challengeToken || null;
    },
    // A token is good for one check, so every send gets a fresh one.
    resetChallenge() {
      this.challengeToken = "";
      if (this.widgetId !== null) globalThis.turnstile?.reset(this.widgetId);
    },

    revalidate() {
      if (this.tried) this.errors = validateEarlyAccess(this.draft);
    },
    errorCount() { return Object.keys(this.errors).length; },

    async submit() {
      this.tried = true;
      this.failed = false;
      this.errors = validateEarlyAccess(this.draft);
      if (this.errorCount()) {
        // After the tick, once Alpine has marked the fields aria-invalid.
        this.$nextTick(() => this.$root.querySelector("[aria-invalid='true']")?.focus());
        return;
      }
      this.sending = true;
      this.challengeMissing = false;
      try {
        const token = await this.challenge();
        if (TURNSTILE_SITE_KEY && !token) {
          this.challengeMissing = true;
          return;
        }
        const payload = earlyAccessPayload(this.draft, globalThis.location?.hostname);
        if (token) payload.turnstileToken = token;
        await sendEarlyAccess(payload);
        this.sentHandle = normalizeHandle(this.draft.handle);
        this.sent = true;
        clearReferral();
      } catch {
        this.failed = true;
      } finally {
        this.sending = false;
        if (!this.sent) this.resetChallenge();
      }
    },
  }));
}
