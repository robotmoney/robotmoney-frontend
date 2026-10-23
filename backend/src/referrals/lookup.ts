// The public referral-code lookup and the admin projections (issue 1371,
// docs/technical/referrals-spec.md §5, §6).
//
// THE LOOKUP answers one question: is this ONE code active right now, and whose
// is it. Every other outcome (unknown, malformed, draft, scheduled, disabled, a
// deactivated member's, a missing member's) is the same `null`, which the route
// turns into one byte-identical 404. It says nothing about wallet eligibility,
// launch status or credit, and it never reads the chain.
//
// ONE DATABASE READ: the member's row by primary key, through the registered
// query boundary, as rm_app. The registry itself is the reviewed config file
// (config-files.ts), loaded once per process.
import type { AdminMemberReferral, AdminReferralCorrection, AdminReferralCorrectionsResponse, ReferralCodeCheck } from "@robotmoney/contract";
import { normalizeReferralCode } from "@robotmoney/contract";
import { sql } from "../db/client.ts";
import { on, registerQuery } from "../db/registry.ts";
import { testSeamArmed, testSeamRefusal } from "../test-seam.ts";
import type { RpcCallOptions } from "../chain/base-rpc-client.ts";
import { configDigest, loadReferralConfig, type ReferralConfig } from "./config-files.ts";
import { checkCorrectionLog, correctionMessage, verifyContractSignature, type CorrectionEntry, type RevocationEntry } from "./corrections.ts";
import { codeStateAt, findCode, selectAdminRecord } from "./registry.ts";

const readMemberById = registerQuery({
  role: "rm_app",
  object: "swarm_members",
  privileges: ["SELECT"],
  site: "src/referrals/lookup:lookupReferralCode.member",
  purpose: "Read the handle, name and status of the member an active referral code names, by primary key, for GET /api/referrals/codes/:code.",
  callers: ["src/api/routes/referrals"],
  probe: { statement: "SELECT id, handle, name, status FROM swarm_members WHERE id = $1", params: ["probe"] },
});

let config: ReferralConfig | null = null;

/** The referral configuration in force: the committed files, unless a test replaced them. */
export function referralConfig(): ReferralConfig {
  config ??= loadReferralConfig();
  return config;
}

/** Replace the configuration for this test process; null reloads the files. Refused outside the test harness. */
export function _setReferralConfigForTests(next: ReferralConfig | null): void {
  if (!testSeamArmed()) throw testSeamRefusal("_setReferralConfigForTests", "Referral configuration changes only by a reviewed change to backend/src/referrals/config.");
  config = next;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * The public answer for `raw` when it is a code active at `at`, else null.
 * Throws only when the database read fails (the route answers 503).
 */
export async function lookupReferralCode(raw: string, at: number = nowSeconds()): Promise<ReferralCodeCheck | null> {
  const code = normalizeReferralCode(raw);
  if (code === null) return null;
  const record = findCode(referralConfig().registry, code);
  if (!record || codeStateAt(record, at) !== "active") return null;
  if (record.beneficiary.kind === "channel") return { code: record.code, channel: record.beneficiary.channel };
  const memberId = record.beneficiary.memberId;
  const rows = await on(sql, readMemberById)<{ id: string; handle: string | null; name: string; status: string }>`SELECT id, handle, name, status FROM swarm_members WHERE id = ${memberId}`;
  const member = rows[0];
  if (!member) {
    // Only a manual rm_owner run removes a member row (no runtime role holds
    // DELETE, D55 decision 6). An active code pointing at nothing is an
    // operational integrity error; the public answer stays the uniform 404.
    console.error(`referral integrity error: active code ${record.code} names member ${memberId}, whose swarm_members row is missing`);
    return null;
  }
  if (member.status !== "active") return null;
  return { code: record.code, member: { handle: member.handle ?? member.id, name: member.name } };
}

/** AdminMember.referral for one member: the record selectAdminRecord picks, or null. Config only; no database read. */
export function memberReferral(memberId: string, at: number = nowSeconds()): AdminMemberReferral | null {
  const mine = referralConfig().registry.codes.filter((r) => r.beneficiary.kind === "member" && r.beneficiary.memberId === memberId);
  const record = selectAdminRecord(mine, at);
  if (!record) return null;
  const state = codeStateAt(record, at);
  return { code: record.code, state, enabled: state === "active", termsVersion: record.termsVersion, enabledAt: record.enabledAt, disabledAt: record.disabledAt ?? record.cancelledAt };
}

/**
 * GET /api/admin/referrals/corrections: the correction log with what the panel
 * can verify now. EIP-191 signatures are checked locally; an EIP-1271 one by one
 * read of the wallet contract at the latest block. Read-only: there is no write.
 */
export async function adminCorrections(rpc: RpcCallOptions): Promise<AdminReferralCorrectionsResponse> {
  const { registry, corrections } = referralConfig();
  const checks = new Map(checkCorrectionLog(corrections, registry).entries.map((c) => [c.id, c]));
  const revocations = new Map<string, RevocationEntry>();
  for (const e of corrections.entries) if (e.type === "revocation" && (checks.get(e.id)?.problems.length ?? 1) === 0) revocations.set(e.revokes, e);
  const out: AdminReferralCorrection[] = [];
  for (const e of corrections.entries) {
    if (e.type !== "correction") continue;
    const c = e as CorrectionEntry;
    const check = checks.get(c.id)!;
    let status: AdminReferralCorrection["check"]["status"] = check.problems.length ? "rejected" : "accepted";
    const problems = [...check.problems];
    if (status === "accepted" && check.needsContractSignatureCheck) {
      const v = await verifyContractSignature(c, rpc);
      status = v.status;
      if (v.problem) problems.push(v.problem);
    }
    const rev = revocations.get(c.id);
    out.push({
      id: c.id,
      kind: c.kind,
      chainId: c.chainId,
      wallet: c.wallet,
      code: c.code,
      deposit: c.deposit,
      recordedAt: c.recordedAt,
      recordedBy: c.recordedBy,
      reason: c.reason,
      signature: c.signature ? { scheme: c.signature.scheme, expiresAt: c.signature.expiresAt, nonce: c.signature.nonce, signature: c.signature.signature, message: correctionMessage(c as CorrectionEntry & { signature: NonNullable<CorrectionEntry["signature"]> }) } : null,
      revocation: rev ? { id: rev.id, recordedAt: rev.recordedAt, recordedBy: rev.recordedBy, reason: rev.reason } : null,
      check: { status, problems },
    });
  }
  return { corrections: out, logDigest: configDigest(corrections) };
}
