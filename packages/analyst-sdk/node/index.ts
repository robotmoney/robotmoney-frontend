// The package's node:fs edge (issue 1765): `@robotmoney/analyst-sdk/node`.
// Everything here reads or writes files, so it lives outside src/, which stays
// pure (scripts/tests/unit/analyst-sdk-purity.test.ts). The package entry `.`
// never exports these: a client that only computes never pulls in node:fs.
//   backups-dir.ts        openBackupsDir(dir, asOf?), a csv-backups folder read in place
//   supplementary-dir.ts  the supplementary directory: its node:fs reader, and writing it
//   hash.ts               sha256(bytes), the hash both manifests record
//   universe-file.ts      universeFromFile(path), a universe file read and checked
export * from "./backups-dir.ts";
export * from "./supplementary-dir.ts";
export * from "./hash.ts";
export * from "./universe-file.ts";
