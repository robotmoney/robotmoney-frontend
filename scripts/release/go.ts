// scripts/release/go.ts — the operator's one recorded go (D61 rule 1).
//
// "The operator's authority is one recorded go for the release, given before
// the run, never a keystroke during it." The go is a small text file the
// operator writes and the runner reads. It names the release, the commit and
// the target; a go for a different release or target refuses. The go is the
// one source of the release commit: the target files name none, and the runner
// renders every `{commit}` from the go's `commit:` line. The runner journals
// the go's sha256, and a resumed run must present the same file.
//
//   release: v0.6.0
//   commit:  <40-hex sha>
//   target:  prod
//   recovery: <path or sha256 of the signed recovery matrix>   (SC.1, runbook section 8)
//   operator: <name>          (optional)
//   date:     2026-10-08      (optional)
//   note:     <free text>     (optional)
//
// Blank lines and lines starting with `#` are ignored. Unknown keys refuse.
import { createHash } from "node:crypto";

export interface GoRecord {
  readonly release: string;
  readonly commit: string;
  readonly target: string;
  /** The signed recovery matrix (SC.1): a file path, or the sha (40 or 64 hex) of the signed file. */
  readonly recovery: string;
  readonly operator?: string;
  readonly date?: string;
  readonly note?: string;
  readonly sha256: string;
}

const REQUIRED = ["release", "commit", "target", "recovery"] as const;

/** A recovery reference is a sha (40 or 64 hex) or a path (absolute, ~/ or ./). */
export const RECOVERY_REF_RE = /^([0-9a-f]{40}|[0-9a-f]{64}|[/~.][^\s]*)$/;
const OPTIONAL = ["operator", "date", "note"] as const;

/** Parse and check a go file against the release and target the run acts on. */
export function validateGo(
  text: string,
  expected: { release: string; target: string },
): { go: GoRecord } | { errors: string[] } {
  const errors: string[] = [];
  const fields: Record<string, string> = {};
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const colon = line.indexOf(":");
    if (colon <= 0) {
      errors.push(`line ${i + 1}: expected "key: value"`);
      return;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!(REQUIRED as readonly string[]).includes(key) && !(OPTIONAL as readonly string[]).includes(key)) {
      errors.push(`line ${i + 1}: unknown key "${key}"`);
      return;
    }
    if (key in fields) errors.push(`line ${i + 1}: "${key}" given twice`);
    fields[key] = value;
  });
  for (const key of REQUIRED) if (!fields[key]) errors.push(`the go names no ${key}`);
  if (fields.commit && !/^[0-9a-f]{40}$/.test(fields.commit)) errors.push(`the go's commit must be a full 40-hex SHA`);
  if (fields.release && fields.release !== expected.release) errors.push(`the go is for release ${fields.release}; this run is ${expected.release}`);
  if (fields.target && fields.target !== expected.target) errors.push(`the go is for target ${fields.target}; this run is ${expected.target}`);
  if (fields.recovery && !RECOVERY_REF_RE.test(fields.recovery)) errors.push("the go's recovery must be the path or the sha of the signed recovery matrix (SC.1)");
  if (errors.length > 0) return { errors };
  return {
    go: {
      release: fields.release!, commit: fields.commit!, target: fields.target!, recovery: fields.recovery!,
      ...(fields.operator ? { operator: fields.operator } : {}),
      ...(fields.date ? { date: fields.date } : {}),
      ...(fields.note ? { note: fields.note } : {}),
      sha256: createHash("sha256").update(text).digest("hex"),
    },
  };
}
