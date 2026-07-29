// Vendored copy of @robotmoney/contract runtime values for the no-build frontend.
// Source of truth: /contract/src. Regenerate with `bun run sync-contract`
// (a file copy, not a bundler). DTO *types* are consumed via JSDoc:
//   /** @typedef {import('@robotmoney/contract').Comment} Comment */
export { ROUTES, path } from "./routes.js";
export {
  canonicalizeApplication,
  buildOnboardingPrompt,
  ONBOARDING_PROMPT,
  COMMITTEE_ONBOARDING_SKILL_URL,
  APPLY_HOW_TO_STEPS,
} from "./committee-application.js";

// Mirrors contract/src/committee.js COMMITTEE_ROSTER_CAP. Interim: the apply
// page derives seats-open from members.length vs this constant. The durable
// fix is the members API returning { rosterCap, seatsAvailable } so the client
// need not hardcode the cap (backend lane).
export const COMMITTEE_ROSTER_CAP = 10;
