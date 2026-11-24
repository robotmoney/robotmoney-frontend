// `bun scripts/regime-diff-note.ts` rewrites tests/golden/regime-diff-1741.json
// (issue 1741): run it after a change that moves the v4 history.
import { writeFileSync } from "node:fs";
import { computeDiffNote, NOTE_PATH } from "../tests/support/regime-diff-note.ts";

const note = computeDiffNote();
writeFileSync(NOTE_PATH, JSON.stringify(note, null, 2) + "\n");
console.log(JSON.stringify(note, null, 2));
