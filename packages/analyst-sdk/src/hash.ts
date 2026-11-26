// The SDK's one SHA-256 (issue 1765). Pure: no filesystem, environment or
// network. Every hash the SDK's code (src/, node/ and bin/) checks or records
// goes through it: the archive reader's file digests (src/archive/reader.ts),
// the supplementary manifest check (src/input/supplementary.ts), the replay
// comparison's row digests (src/replay/compare.ts), the replay's payload and
// report checks (src/replay/replay.ts), the stage cache's input digest
// (src/engine/cache.ts), the manifests the node edge writes, and the input
// manifest check of `bun run regime --provenance` (bin/regime.ts). node/hash.ts
// re-exports it. A string is hashed as its UTF-8 bytes, so sha256(text) equals
// sha256(new TextEncoder().encode(text)).
//
// The one deliberate exception is inputSha256 in src/allocate/labels.ts: it
// feeds the rows into one incremental hash, one update per row, so a long
// input is never joined into one string first. This one-shot helper cannot do
// that. The package's maintenance scripts (scripts/) are not SDK code and keep
// their own.
import { createHash } from "node:crypto";

/** The lowercase hex SHA-256 of `data`: a string as its UTF-8 bytes, or the bytes themselves. */
export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
