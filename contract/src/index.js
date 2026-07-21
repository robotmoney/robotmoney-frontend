// Runtime entrypoint for the contract. Only route data has a runtime form;
// all DTOs are compile-time types declared in the companion .d.ts files.
export { ROUTES, path } from "./routes.js";
export { applicationProofMessage, canonicalizeSubmission } from "./signing.js";
export { REGIME_RISK_OFF, REGIME_RISK_ON, classifyRegime } from "./regime.js";
export { STANCES, COMMITTEE_ROSTER_CAP, DEMO_NO_SHOWS, demoAttends, stanceFor } from "./committee.js";
export { SITE_ORIGIN, SITE_ROUTES, SITE_REDIRECTS, SITE_PATHS, metaForPath, injectSiteMeta } from "./site.js";
