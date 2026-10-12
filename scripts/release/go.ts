// scripts/release/go.ts — the operator's one recorded go (D61 rule 1).
//
// "The operator's authority is one recorded go for the release, given before
// the run, never a keystroke during it." The go is a small text file the
// operator writes and the runner reads. It names the release, the ref and the
// target; a go for a different release or target refuses. The go is the one
// source of the release ref: the target files name none. The runner journals
// the go's sha256, and a resumed run must present the same file.
//
// The ref is one key, by policy (D64, owner, 2026-10-10):
//   - a stage go carries `commit: <40-hex sha>`, a commit on releases-A.B.x;
//   - a production go carries `tag: vA.B.C-rc.N`, the rc cut at the commit
//     stage passed. Production never runs from a branch name or a bare commit.
// The runner resolves a tag to its commit on the control machine (./run.ts)
// and renders every `{commit}` from it; `{ref}` is the tag or the commit as
// the go wrote it.
//
//   release: v0.6.0
//   commit:  <40-hex sha>          (stage)
//   tag:     v0.6.0-rc.0           (prod)
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
  /** The commit as the go wrote it (stage), or undefined until the tag resolves (prod). */
  readonly commit?: string;
  /** The rc tag the go names (prod). */
  readonly tag?: string;
  readonly target: string;
  /** The signed recovery matrix (SC.1): a file path, or the sha (40 or 64 hex) of the signed file. */
  readonly recovery: string;
  readonly operator?: string;
  readonly date?: string;
  readonly note?: string;
  readonly sha256: string;
}

/** A go whose ref is resolved: `commit` is the commit every `{commit}` renders, `ref` what the go wrote. */
export type ResolvedGo = GoRecord & { readonly commit: string; readonly ref: string };

const REQUIRED = ["release", "target", "recovery"] as const;
const REF_KEYS = ["commit", "tag"] as const;

/** A recovery reference is a sha (40 or 64 hex) or a path (absolute, ~/ or ./). */
export const RECOVERY_REF_RE = /^([0-9a-f]{40}|[0-9a-f]{64}|[/~.][^\s]*)$/;
/** `vA.B.C-rc.N` */
export const RC_TAG_RE = /^v\d+\.\d+\.\d+-rc\.\d+$/;
const OPTIONAL = ["operator", "date", "note"] as const;

/** PURE. The release branch of a release: `v0.6.1` → `releases-0.6.x` (policy §2). */
export function releaseBranch(release: string): string {
  const m = /^v(\d+)\.(\d+)\.\d+/.exec(release);
  if (!m) throw new Error(`"${release}" is not a release name (vA.B.C)`);
  return `releases-${m[1]}.${m[2]}.x`;
}

/**
 * PURE. D64: the commit must be on the release branch. `branchesOut` is
 * `git branch -r --contains <commit>` stdout. Every reason it is not, empty
 * when it is.
 */
export function originProblems(release: string, commit: string, branchesOut: string): string[] {
  const want = `origin/${releaseBranch(release)}`;
  const on = branchesOut.split("\n").map((l) => l.trim().replace(/^\* /, "")).filter(Boolean);
  if (on.includes(want)) return [];
  if (on.length === 0) return [`${commit} is on no branch of origin; D64: stage and production run a commit on ${want}`];
  return [`${commit} is on ${on.join(", ")}, not on ${want}; D64: stage and production run a commit on the release branch, never a PR head or a QA branch`];
}

/** Parse and check a go file against the release, target and policy the run acts on. */
export function validateGo(
  text: string,
  expected: { release: string; target: string; rmEnv: "stage" | "prod" },
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
    if (!(REQUIRED as readonly string[]).includes(key) && !(REF_KEYS as readonly string[]).includes(key) && !(OPTIONAL as readonly string[]).includes(key)) {
      errors.push(`line ${i + 1}: unknown key "${key}"`);
      return;
    }
    if (key in fields) errors.push(`line ${i + 1}: "${key}" given twice`);
    fields[key] = value;
  });
  for (const key of REQUIRED) if (!fields[key]) errors.push(`the go names no ${key}`);
  // D64: one ref key, the one the policy takes.
  if (fields.commit && fields.tag) errors.push("the go names both commit and tag; a stage go names a commit, a production go names the rc tag (D64)");
  else if (expected.rmEnv === "prod") {
    if (!fields.tag) errors.push(`the go names no tag; production runs only by the rc tag, tag: ${expected.release}-rc.N (D64)${fields.commit ? "; a bare commit does not authorize a production run" : ""}`);
  } else if (!fields.commit) errors.push(`the go names no commit; a stage go names a commit on ${releaseBranch(expected.release)} (D64)${fields.tag ? "; the rc is cut after stage passes, so a stage go never names a tag" : ""}`);
  if (fields.commit && !/^[0-9a-f]{40}$/.test(fields.commit)) errors.push(`the go's commit must be a full 40-hex SHA`);
  if (fields.tag) {
    if (!RC_TAG_RE.test(fields.tag)) errors.push(`the go's tag must be an rc tag, ${expected.release}-rc.N; got "${fields.tag}"`);
    else if (!fields.tag.startsWith(`${expected.release}-rc.`)) errors.push(`the go's tag ${fields.tag} is not an rc of ${expected.release}`);
  }
  if (fields.release && fields.release !== expected.release) errors.push(`the go is for release ${fields.release}; this run is ${expected.release}`);
  if (fields.target && fields.target !== expected.target) errors.push(`the go is for target ${fields.target}; this run is ${expected.target}`);
  if (fields.recovery && !RECOVERY_REF_RE.test(fields.recovery)) errors.push("the go's recovery must be the path or the sha of the signed recovery matrix (SC.1)");
  if (errors.length > 0) return { errors };
  return {
    go: {
      release: fields.release!, target: fields.target!, recovery: fields.recovery!,
      ...(fields.commit ? { commit: fields.commit } : {}),
      ...(fields.tag ? { tag: fields.tag } : {}),
      ...(fields.operator ? { operator: fields.operator } : {}),
      ...(fields.date ? { date: fields.date } : {}),
      ...(fields.note ? { note: fields.note } : {}),
      sha256: createHash("sha256").update(text).digest("hex"),
    },
  };
}

/** PURE. What the go wrote: the tag, else the commit. */
export function goRef(go: GoRecord): string {
  return go.tag ?? go.commit!;
}
