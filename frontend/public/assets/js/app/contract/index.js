// Vendored copy of @robotmoney/contract runtime values for the no-build frontend.
// Source of truth: /contract/src. Regenerate with `bun run sync-contract`
// (a file copy, not a bundler). DTO *types* are consumed via JSDoc:
//   /** @typedef {import('@robotmoney/contract').Comment} Comment */
export { ROUTES, path } from "./routes.js";
export {
  canonicalizeApplication,
  buildOnboardingPrompt,
  ONBOARDING_PROMPT,
  SWARM_ONBOARDING_SKILL_URL,
  APPLY_HOW_TO_STEPS,
} from "./swarm-application.js";

// Mirrors contract/src/swarm.js SWARM_ROSTER_CAP by hand: sync-contract does
// not copy that file. A fallback only: the apply page reads rosterCap and
// seatsFilled from the members API (#236) and uses this when a response lacks
// them, as the local preview's goldens do.
export const SWARM_ROSTER_CAP = 20;
