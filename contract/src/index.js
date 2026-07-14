// Runtime entrypoint for the contract. Only route data has a runtime form;
// all DTOs are compile-time types declared in the companion .d.ts files.
export { ROUTES, path } from "./routes.js";
export { canonicalizeSubmission } from "./signing.js";
export { REGIME_RISK_OFF, REGIME_RISK_ON, classifyRegime } from "./regime.js";
