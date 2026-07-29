export interface CommitteeApplication {
  name: string;
  contact: string;
  lens?: string;
  publicKey: string;
}

export function canonicalizeApplication(a: CommitteeApplication): string;

export function buildOnboardingPrompt(skillUrl?: string): string;

export const ONBOARDING_PROMPT: string;

export const COMMITTEE_ONBOARDING_SKILL_URL: string;

export interface ApplyHowToStep {
  step: "toolchain" | "apply" | "review" | "claim";
  summary: string;
}

export const APPLY_HOW_TO_STEPS: ApplyHowToStep[];
