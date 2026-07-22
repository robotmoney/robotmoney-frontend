// Vendored copy of @robotmoney/contract runtime values for the no-build frontend.
// Source of truth: /contract/src. Regenerate with `bun run sync-contract`
// (a file copy, not a bundler). DTO *types* are consumed via JSDoc:
//   /** @typedef {import('@robotmoney/contract').Comment} Comment */
export { ROUTES, path } from "./routes.js";
// Mirrors contract/src/committee.js COMMITTEE_ROSTER_CAP. Interim: the durable
// fix is the members API exposing { rosterCap, seatsAvailable } so the frontend
// never carries this number (backend issue; Lucas's lane).
export const COMMITTEE_ROSTER_CAP = 15;
