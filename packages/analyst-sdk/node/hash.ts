// File hashing for the node edge (issue 1765): the SHA-256 that bin/inputs.ts
// writes into an input manifest and node/supplementary-dir.ts writes into a
// supplementary manifest. It is the SDK's one definition, the pure
// src/hash.ts, re-exported here so both manifests hash the way the reader and
// the supplementary check verify them.
export { sha256 } from "../src/hash.ts";
