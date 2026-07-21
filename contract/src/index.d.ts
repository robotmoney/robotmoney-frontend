export * from "./comments";
export * from "./regime";
export * from "./dashboards";
export * from "./committee";
export * from "./projects";
export * from "./admin";
export * from "./site";
export { ROUTES, path } from "./routes";
export function canonicalizeSubmission(s: {
  memberId: string; date: string; subjectId: string; nonce: string;
  stance: string; confidence: number; body?: string; memoUrl?: string;
  proposedWeights?: Record<string, number>;
}): string;
export function applicationProofMessage(memberId: string, publicKey: string): string;
