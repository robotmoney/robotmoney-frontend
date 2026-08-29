import { createHash } from "node:crypto";

// Access keys are never stored in plaintext — only their sha256 hash. Ported
// from the original src/lib/icKeys.ts. Used by swarm apply/activation/submit.
export function hashKey(key: string): string {
  return createHash("sha256").update(key.trim()).digest("hex");
}

// isPlausibleKey() lived here until issue #789. Its only caller was
// POST /api/swarm/register, where `length >= 16` was not a statement about an
// Ed25519 key at all — it let the 14 low-order point encodings straight into
// swarm_member_keys. That route now uses signing.ts's isRegistrablePublicKey,
// the same decode gate every other key path shares.
