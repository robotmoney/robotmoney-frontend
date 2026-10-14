// scripts/release/go.ts — the operator's one recorded go (D61 rule 1).
//
// "The operator's authority is one recorded go for the release, given before
// the run, never a keystroke during it." The go is a small text file the
// operator writes and the runner reads. It names only what nothing else
// records (owner, 2026-10-14): the ref, who gives the go, and when. The release
// comes from the target file and, on production, from the rc tag; the target
// from `--target`; the recovery decision from the release's own runbook YAML
// (SC.1). The runner journals the go's sha256, and a resumed run must present
// the same file.
//
// The ref is one key (D70, owner, 2026-10-14):
//   - a stage go carries `commit: <40-hex sha>`, a commit on a QA branch of
//     the release line (qa/A.B.x-<date>);
//   - a production go carries `tag: vA.B.C-rc.N`, the rc cut on releases-A.B.x
//     at the squash of the stage-passed QA branch. Production never runs from
//     a branch name or a bare commit.
// The runner resolves a tag to its commit on the control machine (./run.ts)
// and renders every `{commit}` from it; `{ref}` is the tag or the commit as
// the go wrote it.
//
//   commit:   <40-hex sha>          (stage)
//   tag:      v0.6.2-rc.0           (prod)
//   operator: <name>
//   date:     2026-10-14
//   note:     <free text>           (optional)
//
// Blank lines and lines starting with `#` are ignored. Unknown keys refuse.
import { createHash } from "node:crypto";

export interface GoRecord {
  /** The release the run's target file names (never written in the go). */
  readonly release: string;
  /** The commit as the go wrote it (stage), or undefined until the tag resolves (prod). */
  readonly commit?: string;
  /** The rc tag the go names (prod). */
  readonly tag?: string;
  /** The run's target (`--target`, never written in the go). */
  readonly target: string;
  readonly operator: string;
  readonly date: string;
  readonly note?: string;
  readonly sha256: string;
}

/** A go whose ref is resolved: `commit` is the commit every `{commit}` renders, `ref` what the go wrote. */
export type ResolvedGo = GoRecord & { readonly commit: string; readonly ref: string };

const REQUIRED = ["operator", "date"] as const;
const REF_KEYS = ["commit", "tag"] as const;
const OPTIONAL = ["note"] as const;
/** Keys a go no longer carries (owner, 2026-10-14), and where each fact lives now. */
export const RETIRED_GO_KEYS: Readonly<Record<string, string>> = Object.freeze({
  release: "the release comes from the target file and the rc tag",
  target: "the target comes from --target",
  recovery: "the recovery decision lives in the release's runbook YAML (recovery:)",
});
/** `vA.B.C-rc.N` */
export const RC_TAG_RE = /^v\d+\.\d+\.\d+-rc\.\d+$/;

/** PURE. The release branch of a release: `v0.6.1` → `releases-0.6.x` (policy §2). */
export function releaseBranch(release: string): string {
  const m = /^v(\d+)\.(\d+)\.\d+/.exec(release);
  if (!m) throw new Error(`"${release}" is not a release name (vA.B.C)`);
  return `releases-${m[1]}.${m[2]}.x`;
}

/** PURE. The QA branch prefix of a release line: `v0.6.2` → `qa/0.6.x-` (policy §2). */
export function qaBranchPrefix(release: string): string {
  const m = /^v(\d+)\.(\d+)\.\d+/.exec(release);
  if (!m) throw new Error(`"${release}" is not a release name (vA.B.C)`);
  return `qa/${m[1]}.${m[2]}.x-`;
}

/**
 * PURE. Where a run's commit must live (D70). `branchesOut` is `git branch -r
 * --contains <commit>` stdout. Production (and the rc tag) needs the release
 * branch; stage needs a QA branch of the release line. Every reason it is not,
 * empty when it is.
 */
export function originProblems(release: string, commit: string, branchesOut: string, rmEnv: "stage" | "prod" = "prod"): string[] {
  const on = branchesOut.split("\n").map((l) => l.trim().replace(/^\* /, "")).filter(Boolean);
  if (rmEnv === "stage") {
    const prefix = `origin/${qaBranchPrefix(release)}`;
    if (on.some((b) => b.startsWith(prefix))) return [];
    return [`${commit} is on ${on.length === 0 ? "no branch of origin" : on.join(", ")}, not on a QA branch ${prefix}<date>; D70: stage runs a pushed QA branch commit, never a PR head or a fix branch`];
  }
  const want = `origin/${releaseBranch(release)}`;
  if (on.includes(want)) return [];
  if (on.length === 0) return [`${commit} is on no branch of origin; D70: production runs the rc cut on ${want}`];
  return [`${commit} is on ${on.join(", ")}, not on ${want}; D70: production runs the rc cut on the release branch at the stage-passed squash`];
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
    if (key in RETIRED_GO_KEYS) {
      errors.push(`line ${i + 1}: "${key}" is no longer a go key: ${RETIRED_GO_KEYS[key]}`);
      return;
    }
    if (!(REQUIRED as readonly string[]).includes(key) && !(REF_KEYS as readonly string[]).includes(key) && !(OPTIONAL as readonly string[]).includes(key)) {
      errors.push(`line ${i + 1}: unknown key "${key}"`);
      return;
    }
    if (key in fields) errors.push(`line ${i + 1}: "${key}" given twice`);
    fields[key] = value;
  });
  for (const key of REQUIRED) if (!fields[key]) errors.push(`the go names no ${key}`);
  if (fields.date && !/^\d{4}-\d{2}-\d{2}$/.test(fields.date)) errors.push(`the go's date must be YYYY-MM-DD; got "${fields.date}"`);
  // D70: one ref key, the one the policy takes.
  if (fields.commit && fields.tag) errors.push("the go names both commit and tag; a stage go names a commit, a production go names the rc tag (D70)");
  else if (expected.rmEnv === "prod") {
    if (!fields.tag) errors.push(`the go names no tag; production runs only by the rc tag, tag: ${expected.release}-rc.N (D70)${fields.commit ? "; a bare commit does not authorize a production run" : ""}`);
  } else if (!fields.commit) errors.push(`the go names no commit; a stage go names a commit on a QA branch ${qaBranchPrefix(expected.release)}<date> (D70)${fields.tag ? "; the rc is cut after stage passes, so a stage go never names a tag" : ""}`);
  if (fields.commit && !/^[0-9a-f]{40}$/.test(fields.commit)) errors.push(`the go's commit must be a full 40-hex SHA`);
  if (fields.tag) {
    if (!RC_TAG_RE.test(fields.tag)) errors.push(`the go's tag must be an rc tag, ${expected.release}-rc.N; got "${fields.tag}"`);
    else if (!fields.tag.startsWith(`${expected.release}-rc.`)) errors.push(`the go's tag ${fields.tag} is not an rc of ${expected.release}`);
  }
  if (errors.length > 0) return { errors };
  return {
    go: {
      release: expected.release, target: expected.target, operator: fields.operator!, date: fields.date!,
      ...(fields.commit ? { commit: fields.commit } : {}),
      ...(fields.tag ? { tag: fields.tag } : {}),
      ...(fields.note ? { note: fields.note } : {}),
      sha256: createHash("sha256").update(text).digest("hex"),
    },
  };
}

/** PURE. What the go wrote: the tag, else the commit. */
export function goRef(go: GoRecord): string {
  return go.tag ?? go.commit!;
}
