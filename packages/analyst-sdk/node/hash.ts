// File hashing for the node edge (issue 1765): the SHA-256 that bin/inputs.ts
// writes into an input manifest and node/supplementary-dir.ts writes into a
// supplementary manifest. One definition, so both manifests hash the same way.
// It uses Bun's hasher, so it lives in node/, outside the pure src/.

/** The lowercase hex SHA-256 of `bytes`. */
export const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
