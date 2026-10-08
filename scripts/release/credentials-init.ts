#!/usr/bin/env bun
// scripts/release/credentials-init.ts — release step R6.2a, run ON THE TARGET HOST,
// before R6.2 moves OPENCODE_API_KEY out of ~/.env. D61 rule 3: the old runbook
// left "credential.json exists at RM_CREDENTIALS with the in-house roster" as an
// operator preparation; this is that preparation, scripted.
//
//   bun scripts/release/credentials-init.ts --receipt-dir <dir>
//
// THE FILE (scripts/lib/swarm/credential-file.ts, spec §6.1, D52). The 0.6 boot
// reads `RM_CREDENTIALS` from ~/.env and loads that file. It is the roster:
// `agents` and `judges`, each entry carrying memberId, publicKeyB64,
// privateJwk, bearer and modelKey, all five required and non-empty. The boot
// hands each participant container its own entry: RM_MEMBER_TOKEN is the
// bearer, the inference key is modelKey (scripts/lib/participant-compose.ts).
// The model key lives in the entry, never in ~/.env (spec §3, preflight check 4).
//
// WHAT IT WRITES. `<HOME>/.config/robotmoney/credential.json` (dir 0700, file
// 0600) with the in-house roster: agents athena, noop-analyst and robot-money,
// judge themis. Each member id is read through rm_readonly from ~/.env; a
// handle that is missing, not `active`, or of the wrong role refuses. Each
// entry gets a FRESH Ed25519 identity (the committed fixture keys are retired,
// spec §9.1 step 6) and the model key from ~/.env's OPENCODE_API_KEY line. The
// bearer is a placeholder (`unbound-<random>`): `prod-init rebind-members`
// (R6.7c) rotates each member onto its new public key and writes the bearer the
// API returns, through credential-file.ts writeCredentialBearer, the file's one
// bearer writer. Until then boot 1's participants answer 401, which R3.8
// observed and boot 2 (R6.7d) cures.
// Then it appends `RM_CREDENTIALS=<path>` to ~/.env when the line is absent.
//
// IDEMPOTENT. An existing file (at RM_CREDENTIALS, or at the default path) with
// the same roster and the same member ids is verified and kept; nothing is
// rewritten, so a resume after R6.2 needs no model key. A different roster
// refuses. It prints key names and handles, never a value.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homeEnvFilePath, loadEnvFile } from "../lib/env-role.ts";
import { loadCredentialFile, parseCredentialFile, type CredentialEntry, type CredentialFile } from "../lib/swarm/credential-file.ts";
import { openReadOnly } from "./db-read.ts";

/** The in-house roster (runbook R6.2, R6.7): who the credential file seats. */
export const IN_HOUSE_ROSTER = Object.freeze({
  agents: Object.freeze(["athena", "noop-analyst", "robot-money"]),
  judges: Object.freeze(["themis"]),
});

/** The model key's line in ~/.env before R6.2 moves it out. */
export const INFERENCE_KEY_LINE = "OPENCODE_API_KEY";

/** The prefix of a bearer rebind-members has not written yet. */
export const UNBOUND_BEARER_PREFIX = "unbound-";

export interface MemberRow { readonly id: string; readonly handle: string; readonly role: string; readonly status: string }

/** `<home>/.config/robotmoney/credential.json`. */
export function defaultCredentialPath(home: string): string {
  return join(home, ".config", "robotmoney", "credential.json");
}

/** PURE. Each roster handle's member id, or every reason the database cannot seat the roster. */
export function resolveRoster(rows: readonly MemberRow[]): { ids: Record<string, string> } | { problems: string[] } {
  const problems: string[] = [];
  const ids: Record<string, string> = {};
  const want = [
    ...IN_HOUSE_ROSTER.agents.map((h) => [h, "member"] as const),
    ...IN_HOUSE_ROSTER.judges.map((h) => [h, "judge"] as const),
  ];
  for (const [handle, role] of want) {
    const matches = rows.filter((r) => r.handle === handle);
    if (matches.length === 0) { problems.push(`no member has handle ${handle}`); continue; }
    if (matches.length > 1) { problems.push(`${matches.length} members have handle ${handle}`); continue; }
    const m = matches[0]!;
    if (m.status !== "active") problems.push(`${handle} is ${m.status}, not active`);
    if (m.role !== role) problems.push(`${handle} has role ${m.role}, not ${role}`);
    ids[handle] = m.id;
  }
  return problems.length > 0 ? { problems } : { ids };
}

/** PURE. Every way an existing file's roster differs from the in-house roster and its member ids. */
export function rosterDifferences(file: CredentialFile, ids: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  const compare = (namespace: "agents" | "judges", want: readonly string[]) => {
    const have = Object.keys(file[namespace]).sort();
    const expected = [...want].sort();
    if (have.join(",") !== expected.join(",")) out.push(`${namespace} are [${have.join(", ")}], expected [${expected.join(", ")}]`);
    for (const h of want) {
      const e = file[namespace][h];
      if (e && e.memberId !== ids[h]) out.push(`${namespace}.${h} names member ${e.memberId}, the database has ${ids[h]}`);
    }
  };
  compare("agents", IN_HOUSE_ROSTER.agents);
  compare("judges", IN_HOUSE_ROSTER.judges);
  return out;
}

/** One fresh Ed25519 identity in the shape the credential file carries (spoof-keys.ts freshIdentity). */
export function freshIdentity(): Pick<CredentialEntry, "publicKeyB64" | "privateJwk"> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" }) as { x?: string };
  return {
    publicKeyB64: Buffer.from(publicJwk.x ?? "", "base64url").toString("base64"),
    privateJwk: privateKey.export({ format: "jwk" }) as Record<string, unknown>,
  };
}

/** PURE apart from key generation. The file for the roster, validated by credential-file.ts's own parser. */
export function buildCredentialFile(ids: Readonly<Record<string, string>>, modelKey: string, identity = freshIdentity): CredentialFile {
  const entry = (handle: string): CredentialEntry => ({
    memberId: ids[handle]!,
    ...identity(),
    bearer: `${UNBOUND_BEARER_PREFIX}${randomBytes(16).toString("hex")}`,
    modelKey,
  });
  const file: CredentialFile = {
    agents: Object.fromEntries(IN_HOUSE_ROSTER.agents.map((h) => [h, entry(h)])),
    judges: Object.fromEntries(IN_HOUSE_ROSTER.judges.map((h) => [h, entry(h)])),
  };
  return parseCredentialFile(JSON.stringify(file), "(new credential file)");
}

export interface InitInput {
  readonly home: string;
  readonly homeEnv: Record<string, string>;
  readonly rows: readonly MemberRow[];
  /** Reads an existing credential file (credential-file.ts loadCredentialFile). */
  readonly load: (path: string) => CredentialFile;
  readonly exists: (path: string) => boolean;
}

export type InitPlan =
  | { readonly action: "refuse"; readonly path: string; readonly problems: string[] }
  | { readonly action: "keep"; readonly path: string; readonly appendEnv: boolean }
  | { readonly action: "write"; readonly path: string; readonly file: CredentialFile; readonly appendEnv: boolean };

/** Decide what R6.2a does. Never returns a secret except inside `file`, which only `main` writes. */
export function planInit(input: InitInput, identity = freshIdentity): InitPlan {
  const configured = (input.homeEnv.RM_CREDENTIALS ?? "").trim();
  const path = configured !== "" ? configured : defaultCredentialPath(input.home);
  const appendEnv = configured === "";
  const roster = resolveRoster(input.rows);
  if ("problems" in roster) return { action: "refuse", path, problems: roster.problems };
  if (input.exists(path)) {
    let file: CredentialFile;
    try {
      file = input.load(path);
    } catch (error) {
      return { action: "refuse", path, problems: [`${path} exists and does not load: ${error instanceof Error ? error.message : String(error)}`] };
    }
    const diff = rosterDifferences(file, roster.ids);
    return diff.length > 0 ? { action: "refuse", path, problems: diff.map((d) => `${path}: ${d}`) } : { action: "keep", path, appendEnv };
  }
  if (configured !== "") return { action: "refuse", path, problems: [`RM_CREDENTIALS names ${path}, which does not exist; it is never created at a path the operator named`] };
  const modelKey = (input.homeEnv[INFERENCE_KEY_LINE] ?? "").trim();
  if (modelKey === "") return { action: "refuse", path, problems: [`~/.env has no ${INFERENCE_KEY_LINE} line, so no entry has a model key (run R6.2a before R6.2)`] };
  return { action: "write", path, file: buildCredentialFile(roster.ids, modelKey, identity), appendEnv };
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function main(): Promise<number> {
  const receiptDir = flag("--receipt-dir");
  if (!receiptDir) {
    console.error("usage: bun scripts/release/credentials-init.ts --receipt-dir <dir>");
    return 2;
  }
  const home = process.env.HOME ?? "/root";
  const envPath = homeEnvFilePath(home);
  const homeEnv = loadEnvFile(envPath);
  if (!homeEnv) {
    console.error(`[credentials-init] REFUSE: ${envPath} cannot be read`);
    return 1;
  }
  const handles = [...IN_HOUSE_ROSTER.agents, ...IN_HOUSE_ROSTER.judges];
  const db = await openReadOnly();
  let rows: MemberRow[];
  try {
    rows = await db.query<MemberRow>(
      `SELECT id::text AS id, handle, role, status FROM swarm_members WHERE handle IN (${handles.map((h) => `'${h}'`).join(", ")}) ORDER BY handle`,
    );
  } finally {
    await db.close();
  }
  const plan = planInit({ home, homeEnv, rows, load: loadCredentialFile, exists: existsSync });

  if (plan.action === "write") {
    mkdirSync(dirname(plan.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(plan.path), 0o700);
    const temp = `${plan.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(plan.file, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, plan.path);
    chmodSync(plan.path, 0o600);
    loadCredentialFile(plan.path);
  }
  if (plan.action !== "refuse" && plan.appendEnv) {
    const text = readFileSync(envPath, "utf8");
    appendFileSync(envPath, `${text.endsWith("\n") || text === "" ? "" : "\n"}RM_CREDENTIALS=${plan.path}\n`);
  }

  const receipt = {
    step: "R6.2a",
    path: plan.path,
    action: plan.action,
    roster: { agents: IN_HOUSE_ROSTER.agents, judges: IN_HOUSE_ROSTER.judges },
    members: rows.map((r) => ({ handle: r.handle, id: r.id, role: r.role, status: r.status })),
    entryFields: ["memberId", "publicKeyB64", "privateJwk", "bearer", "modelKey"],
    bearers: plan.action === "write" ? "placeholders; rebind-members (R6.7c) writes the real ones" : "kept",
    rmCredentialsAppended: plan.action !== "refuse" && plan.appendEnv,
    problems: plan.action === "refuse" ? plan.problems : [],
    at: new Date().toISOString(),
  };
  mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
  const file = join(receiptDir, "credentials-init.json");
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`[credentials-init] ${plan.path}: ${plan.action}; agents ${IN_HOUSE_ROSTER.agents.join(", ")}; judges ${IN_HOUSE_ROSTER.judges.join(", ")}`);
  if (receipt.rmCredentialsAppended) console.log(`[credentials-init] appended RM_CREDENTIALS to ${envPath}`);
  console.log(`[credentials-init] receipt: ${file}`);
  if (plan.action === "refuse") for (const p of plan.problems) console.error(`[credentials-init] REFUSE: ${p}`);
  return plan.action === "refuse" ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
