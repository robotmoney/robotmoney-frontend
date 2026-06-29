export * from "./comments";
export * from "./dashboards";
export * from "./committee";
export { ROUTES, path } from "./routes";
export function canonicalizeSubmission(s: {
  memberId: string; date: string; subjectId: string; nonce: string;
  stance: string; confidence: number; body?: string;
}): string;
