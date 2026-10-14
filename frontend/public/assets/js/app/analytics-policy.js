import { routeMetaFor } from "./routes.js";

export const CONSENT_KEY = "rm_analytics_consent";
export const CONSENT_VERSION = 1;
/** @type {readonly string[]} */
export const QUERY_ALLOWLIST = Object.freeze([]); // No URL query values are collected.

/** @param {{origin: string}} location */
export function isProduction(location) {
  return location.origin === "https://robotmoney.network";
}

/** @param {string} pathname */
export function isPrivilegedRoute(pathname) {
  // Normalize trailing slash/encoded segments before testing the same route policy.
  try { pathname = decodeURIComponent(pathname).replace(/\/+$/, "") || "/"; }
  catch { return true; }
  return /^\/(admin|dashboard|market|list|list2|list3|agents|lobster|vaults|wallets|methodology|about|ask-mr-roboto)(?:\/|$)/.test(pathname)
    || !!routeMetaFor(pathname)?.gated;
}

/** @param {{origin: string, pathname: string}} location */
export function analyticsEligible(location) {
  return isProduction(location) && !isPrivilegedRoute(location.pathname);
}

/** @param {Pick<Storage, "getItem">} storage */
export function readConsent(storage) {
  try {
    const value = JSON.parse(storage.getItem(CONSENT_KEY) || "null");
    return value?.version === CONSENT_VERSION && ["accepted", "rejected"].includes(value.choice)
      ? value.choice : "unknown";
  } catch { return "unknown"; }
}

/** @param {{origin: string, pathname: string, search?: string, hash?: string}} location @param {string} title */
export function pageFields(location, title) {
  // Deliberately retain no query or hash, including campaign parameters.
  return { page_title: title, page_path: location.pathname,
    page_location: location.origin + location.pathname };
}
