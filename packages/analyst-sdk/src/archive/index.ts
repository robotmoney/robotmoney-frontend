// The archive module (issue 1765): `@robotmoney/analyst-sdk/archive`. Format 1
// is defined once, in format1.ts (D80): the layout, the row encoding, the backup
// cut rule and the run input collector, used by both its writers and its
// reader. reader.ts is the reader core over an injected ArchiveFiles. Both are
// pure; the node:fs ArchiveFiles is openBackupsDir in `@robotmoney/analyst-sdk/node`.
export * from "./format1.ts";
export * from "./reader.ts";
