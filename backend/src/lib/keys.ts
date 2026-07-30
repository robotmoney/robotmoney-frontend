import { createHash } from "node:crypto";

// Access keys are never stored in plaintext — only their sha256 hash. Ported
// from the original src/lib/icKeys.ts. Used by swarm apply/activation/submit.
export function hashKey(key: string): string {
  return createHash("sha256").update(key.trim()).digest("hex");
}

export function isPlausibleKey(key: string): boolean {
  return typeof key === "string" && key.trim().length >= 16;
}
