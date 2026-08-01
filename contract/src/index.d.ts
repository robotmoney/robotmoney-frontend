export * from "./comments";
export * from "./regime";
export * from "./dashboards";
export * from "./committee";
export * from "./committee-application";
export * from "./projects";
export * from "./admin";
export { ROUTES, path } from "./routes";
export function canonicalizeSubmission(s: {
  memberId: string; date: string; subjectId: string; nonce: string;
  stance: string; confidence: number; body?: string; memoUrl?: string;
  weights?: CommitteeBucketWeight[];
}): string;
export function canonicalizeClaimChallenge(challenge: {
  memberId: string;
  challenge: string;
  expiresAt: string;
}): string;
