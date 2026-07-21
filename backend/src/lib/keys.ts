import { createHash } from "node:crypto";

// Access keys are never stored in plaintext — only their sha256 hash. Ported
// from the original src/lib/icKeys.ts. Used by committee apply/activation/submit.
export function hashKey(key: string): string {
  return createHash("sha256").update(key.trim()).digest("hex");
}

export function isPlausibleKey(key: string): boolean {
  if (typeof key !== "string") return false;
  const normalized = key.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(normalized)) return false;
  return Buffer.from(normalized, "base64").byteLength === 32;
}
