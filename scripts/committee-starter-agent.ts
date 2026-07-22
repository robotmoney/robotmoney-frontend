// Minimal one-shot committee agent. It reads the current brief, constructs a
// schema-valid take, signs the canonical payload locally, and submits it. Run it
// from cron or any agent loop; private key material never leaves this process.
import { readFile } from "node:fs/promises";
import { canonicalizeSubmission, path, ROUTES } from "@robotmoney/contract";

export interface StarterConfig {
  apiBaseUrl: string;
  memberId: string;
  memberToken: string;
  identityFile: string;
}

export function draftFromBrief(memberId: string, open: any, brief: any) {
  const buckets: string[] = brief?.responseSchema?.proposedWeights?.buckets || [];
  const equalWeight = buckets.length ? 1 / buckets.length : 0;
  const proposedWeights = buckets.length
    ? Object.fromEntries(buckets.map((bucket, index) => [bucket, index === buckets.length - 1
      ? 1 - equalWeight * (buckets.length - 1)
      : equalWeight]))
    : undefined;
  return {
    memberId,
    date: open.date,
    subjectId: open.subjectId,
    nonce: crypto.randomUUID(),
    stance: "neutral",
    confidence: 0.5,
    body: [
      "**REGIME** Neutral pending a stronger divergence signal.",
      "**ALLOCATION** Keep the portfolio diversified across the permitted framework buckets.",
      `**SUBJECT** ${open.subjectName || open.subjectId} should be reviewed against the brief evidence and stated mandate.`,
    ].join("\n\n"),
    ...(proposedWeights ? { proposedWeights } : {}),
  };
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

async function json(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

export async function runStarterAgent(cfg: StarterConfig, log: (message: string) => void = console.log) {
  const base = cfg.apiBaseUrl.replace(/\/$/, "");
  const open = await fetch(`${base}${ROUTES.committee.openSession}`).then(json);
  if (!open?.id) return { submitted: false, reason: "no collecting session" };
  log(`WINDOW OPEN ${open.date}/${open.subjectId} closes=${open.windowClosesAt || "see brief"}`);

  const briefUrl = new URL(`${base}${ROUTES.committee.brief}`);
  briefUrl.searchParams.set("date", open.date);
  briefUrl.searchParams.set("subject", open.subjectId);
  const brief = await fetch(briefUrl, { headers: { Authorization: `Bearer ${cfg.memberToken}` } }).then(json);
  if (brief.alreadySubmitted) return { submitted: false, reason: "already submitted", sessionId: open.id };
  log(`REGIME READ ${brief?.body?.regime?.regime || "unavailable"}`);

  const draft: ReturnType<typeof draftFromBrief> & { memoUrl?: string } = draftFromBrief(cfg.memberId, open, brief);
  log(`AUTHORED stance=${draft.stance} confidence=${draft.confidence}`);
  const memo = await fetch(`${base}${ROUTES.committee.memos}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.memberToken}` },
    body: JSON.stringify({ sessionId: open.id, title: `${open.subjectName || open.subjectId}: ${draft.stance}`, body: draft.body }),
  }).then(json);
  draft.memoUrl = memo.url;
  log(`MEMO ${memo.url}`);
  const identity = JSON.parse(await readFile(cfg.identityFile, "utf8"));
  if (identity.memberId && identity.memberId !== cfg.memberId) throw new Error(`identity belongs to ${identity.memberId}`);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", fromBase64(identity.privateKeyPkcs8), { name: "Ed25519" }, false, ["sign"],
  );
  const signature = Buffer.from(await crypto.subtle.sign(
    { name: "Ed25519" }, privateKey, new TextEncoder().encode(canonicalizeSubmission(draft)),
  )).toString("base64");
  log("SIGNED ed25519=true");
  const response = await fetch(`${base}${ROUTES.committee.submit}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.memberToken}` },
    body: JSON.stringify({ ...draft, signature }),
  }).then(json);
  log(`SUBMITTED verified=${response.verified} receipt=${response.url}`);
  return { submitted: true, ...response };
}

async function main() {
  // Prefer RM_MEMBER_TOKEN_FILE: an inline RM_MEMBER_TOKEN lands in shell
  // history in plaintext (and in any screen recording). The claim page
  // downloads the token as a file precisely so the command carries no secret.
  let memberToken = process.env.RM_MEMBER_TOKEN || "";
  if (!memberToken && process.env.RM_MEMBER_TOKEN_FILE) {
    memberToken = (await readFile(
      process.env.RM_MEMBER_TOKEN_FILE.replace(/^~(?=\/)/, process.env.HOME || "~"), "utf8",
    )).trim();
  }
  const cfg = {
    apiBaseUrl: process.env.RM_API_BASE_URL || "https://api.robot.money",
    memberId: process.env.RM_MEMBER_ID || "",
    memberToken,
    identityFile: (process.env.RM_IDENTITY_FILE || "").replace(/^~(?=\/)/, process.env.HOME || "~"),
  };
  for (const [key, value] of Object.entries(cfg)) if (!value) throw new Error(`missing ${key}`);
  console.log(JSON.stringify(await runStarterAgent(cfg), null, 2));
}

if (import.meta.main) main().catch((error) => { console.error(error); process.exit(1); });
