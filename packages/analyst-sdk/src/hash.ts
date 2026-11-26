// The SDK's one SHA-256 (issue 1765). Pure: no filesystem, environment or
// network. Every hash the SDK checks or records goes through it: the archive
// reader's file digests (src/archive/reader.ts), the supplementary manifest
// check (src/input/supplementary.ts), the replay comparison's row digests
// (src/replay/compare.ts), the replay's payload and report checks
// (src/replay/replay.ts), the stage cache's input digest (src/engine/cache.ts),
// and the manifests the node edge writes
// (node/hash.ts re-exports it). A string is hashed as its UTF-8 bytes, so
// sha256(text) equals sha256(new TextEncoder().encode(text)).
import { createHash } from "node:crypto";

/** The lowercase hex SHA-256 of `data`: a string as its UTF-8 bytes, or the bytes themselves. */
export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
