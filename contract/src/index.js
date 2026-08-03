// Runtime entrypoint for the contract. Only route data has a runtime form;
// all DTOs are compile-time types declared in the companion .d.ts files.
export { ROUTES, path } from "./routes.js";
export { canonicalizeClaimChallenge, canonicalizeSubmission } from "./signing.js";
export { REGIME_RISK_OFF, REGIME_RISK_ON, classifyRegime } from "./regime.js";
export { STANCES, SWARM_ROSTER_CAP, DEMO_NO_SHOWS, demoAttends, stanceFor } from "./swarm.js";
export {
  canonicalizeApplication,
  buildOnboardingPrompt,
  ONBOARDING_PROMPT,
  SWARM_ONBOARDING_SKILL_URL,
  APPLY_HOW_TO_STEPS,
} from "./swarm-application.js";
