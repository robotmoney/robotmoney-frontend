export * from "./comments";
export * from "./regime";
export * from "./dashboards";
export * from "./swarm";
export * from "./swarm-application";
export * from "./consensus-receipt";
export * from "./projects";
export * from "./admin";
export { ROUTES, path } from "./routes";
export function canonicalizeSubmission(s: {
  memberId: string; date: string; subjectId: string; nonce: string;
  stance: string; confidence: number; body?: string; memoUrl?: string;
  // Issue #978: naming a reportSnapshotId signs schema 2.0 (an explicit
  // schemaVersion marker plus this field); omitting it signs schema 1.0,
  // byte-identical to every submission signed before this field existed.
  reportSnapshotId?: string;
  weights?: SwarmBucketWeight[];
}): string;
export function canonicalizeClaimChallenge(challenge: {
  memberId: string;
  challenge: string;
  expiresAt: string;
}): string;
/**
 * The bytes a judge participant signs over its judgement (issue #1026 W3,
 * smoke-production-spec.md §6.2). A separate signing domain from takes and
 * claim challenges: `purpose` is first, so no judgement's bytes can ever equal
 * a take's.
 */
export function canonicalizeJudgement(j: {
  memberId: string;
  sessionId: string;
  nonce: string;
  model: string;
  promptHash: string;
  inputsDigest: string;
  /** The model's raw answer, exactly as the judge received it. */
  opinion: string;
}): string;
