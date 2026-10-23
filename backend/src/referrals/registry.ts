// The referral code registry: lifecycle states, validation of one revision, and
// validation of a revision against the previous accepted one (issue 1371,
// docs/technical/referrals-spec.md §5).
//
// WHAT IT IS. Versioned, reviewed backend configuration
// (backend/src/referrals/config/registry.json), not a table and not an admin
// write. An operator issues, schedules, cancels or disables a code by a reviewed
// change to that file, and the change reaches production only in a release.
// The report and the public lookup read the same records through this module.
//
// TIME. Every time is an ISO 8601 UTC string `YYYY-MM-DDTHH:MM:SSZ`, compared
// as Unix seconds against block timestamps. Intervals are half-open:
// a code is active at t when `enabledAt <= t` and (no disable, or `t < disabledAt`).
//
// PROSPECTIVE ONLY. Validation of a new revision takes the time it is deployed
// (`deployedAt`: the release tag time, or "now" as a lower bound in CI) and
// rejects any newly introduced activation, cancellation or disable earlier than
// that, so time passing between approval and deployment can never turn a
// prospective change into a retroactive one (spec §5, §11 "Deployment time of
// registry revisions").
import { isNormalizedReferralCode } from "@robotmoney/contract";
import type { ReferralCodeState } from "@robotmoney/contract";

export type ReferralBeneficiary = { kind: "member"; memberId: string } | { kind: "channel"; channel: string };

/** The beneficiary as it was named when the code was issued. Kept for history; never updated by a rename. */
export type ReferralDisplaySnapshot = { handle: string; name: string } | { channel: string };

export interface ReferralCodeRecord {
  /** Normalized code. A member's is `rm_` plus the member's handle at issue time (a rejoin adds `-<suffix>`). */
  code: string;
  /** Immutable once issued. */
  beneficiary: ReferralBeneficiary;
  display: ReferralDisplaySnapshot;
  /** The terms version a member accepted; required before activation. Always null for a team channel. */
  termsVersion: string | null;
  /** Null while draft. */
  enabledAt: string | null;
  disabledAt: string | null;
  /** A scheduled activation cancelled before it began; the record stays, inactive forever. */
  cancelledAt: string | null;
}

export interface ReferralRegistry {
  schemaVersion: 1;
  chainId: number;
  /** The one global launch block; null until launch is approved. Immutable once set. */
  launch: { blockNumber: number | null };
  codes: ReferralCodeRecord[];
}

export const REFERRAL_CHAIN_ID = 8453;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const CHANNEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Unix seconds of a strict ISO 8601 UTC string, or null when it is not one. */
export function isoToSeconds(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || !ISO_UTC.test(iso)) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || new Date(ms).toISOString().replace(".000Z", "Z") !== iso) return null;
  return ms / 1000;
}

function secs(iso: string | null): number | null {
  return iso === null ? null : isoToSeconds(iso);
}

/** The record's state at Unix second `t` (spec §5). */
export function codeStateAt(record: ReferralCodeRecord, t: number): ReferralCodeState {
  const enabled = secs(record.enabledAt);
  if (enabled === null) return "draft";
  const cancelled = secs(record.cancelledAt);
  if (cancelled !== null && t >= cancelled) return "disabled";
  if (t < enabled) return "scheduled";
  // A cancellation precedes its activation (validateRegistry), so a cancelled
  // record has returned "disabled" above before it could reach here.
  const disabled = secs(record.disabledAt);
  if (disabled !== null && t >= disabled) return "disabled";
  return "active";
}

/** The half-open active interval [start, end), or null for a draft or a cancelled record. */
export function activeInterval(record: ReferralCodeRecord): { start: number; end: number } | null {
  const start = secs(record.enabledAt);
  if (start === null || record.cancelledAt !== null) return null;
  return { start, end: secs(record.disabledAt) ?? Number.POSITIVE_INFINITY };
}

export function beneficiaryKey(b: ReferralBeneficiary): string {
  return b.kind === "member" ? `member:${b.memberId}` : `channel:${b.channel}`;
}

export function findCode(registry: ReferralRegistry, code: string): ReferralCodeRecord | undefined {
  return registry.codes.find((r) => r.code === code);
}

/** Every problem with one registry revision on its own, as readable lines. Empty when sound. */
export function validateRegistry(registry: ReferralRegistry): string[] {
  const errors: string[] = [];
  if (registry.schemaVersion !== 1) errors.push("registry: schemaVersion must be 1");
  if (registry.chainId !== REFERRAL_CHAIN_ID) errors.push(`registry: chainId must be ${REFERRAL_CHAIN_ID}`);
  const launch = registry.launch?.blockNumber;
  if (launch !== null && (!Number.isInteger(launch) || (launch as number) < 0)) {
    errors.push("registry: launch.blockNumber must be null or a non-negative integer");
  }
  if (!Array.isArray(registry.codes)) return [...errors, "registry: codes must be an array"];

  const seen = new Set<string>();
  const intervals = new Map<string, { code: string; start: number; end: number }[]>();
  for (const r of registry.codes) {
    const label = `code ${JSON.stringify(r.code)}`;
    if (!isNormalizedReferralCode(r.code)) errors.push(`${label}: not a normalized code (rm_ plus a lowercase slug, 32 characters at most)`);
    if (seen.has(r.code)) errors.push(`${label}: listed more than once; codes are globally unique`);
    seen.add(r.code);

    const b = r.beneficiary;
    if (b?.kind === "member") {
      if (typeof b.memberId !== "string" || b.memberId.trim() === "") errors.push(`${label}: member beneficiary needs a memberId`);
      const d = r.display as { handle?: unknown; name?: unknown };
      if (typeof d?.handle !== "string" || typeof d?.name !== "string" || Object.keys(d).length !== 2) {
        errors.push(`${label}: a member code's display snapshot is exactly { handle, name }`);
      } else if (r.code !== `rm_${d.handle}` && !r.code.startsWith(`rm_${d.handle}-`)) {
        // `rm_<handle>`; a rejoin needs a new code, so it may add a `-<suffix>`.
        errors.push(`${label}: a member code is rm_ plus the member's handle at issue time (${JSON.stringify(d.handle)}), with a -suffix only for a rejoin`);
      }
      if (r.enabledAt !== null && (typeof r.termsVersion !== "string" || r.termsVersion.trim() === "")) {
        errors.push(`${label}: a member code needs a terms version before activation`);
      }
    } else if (b?.kind === "channel") {
      if (typeof b.channel !== "string" || !CHANNEL.test(b.channel)) errors.push(`${label}: channel must be a lowercase slug`);
      const d = r.display as { channel?: unknown };
      if (d?.channel !== b.channel || Object.keys(d ?? {}).length !== 1) errors.push(`${label}: a channel code's display snapshot is exactly { channel }`);
      if (r.termsVersion !== null) errors.push(`${label}: a team channel code has no terms version`);
    } else {
      errors.push(`${label}: beneficiary kind must be "member" or "channel"`);
    }

    for (const field of ["enabledAt", "disabledAt", "cancelledAt"] as const) {
      const v = r[field];
      if (v !== null && isoToSeconds(v) === null) errors.push(`${label}: ${field} must be an ISO 8601 UTC time like 2026-11-01T00:00:00Z`);
    }
    const en = secs(r.enabledAt);
    const dis = secs(r.disabledAt);
    const can = secs(r.cancelledAt);
    if (r.enabledAt === null && (r.disabledAt !== null || r.cancelledAt !== null)) errors.push(`${label}: a draft has no disable or cancellation`);
    if (en !== null && dis !== null && dis <= en) errors.push(`${label}: disabledAt must be after enabledAt`);
    if (r.cancelledAt !== null && r.disabledAt !== null) errors.push(`${label}: a cancelled activation has no disable`);
    if (en !== null && can !== null && can >= en) errors.push(`${label}: a cancellation must come before the activation it cancels`);

    const iv = activeInterval(r);
    if (iv && b) {
      const key = beneficiaryKey(b);
      const list = intervals.get(key) ?? [];
      for (const o of list) {
        if (iv.start < o.end && o.start < iv.end) errors.push(`${label}: active interval overlaps ${o.code} for the same beneficiary`);
      }
      list.push({ code: r.code, ...iv });
      intervals.set(key, list);
    }
  }
  return errors;
}

/**
 * Every problem with `next` as the successor of the previous accepted revision
 * `prev`, deployed at Unix second `deployedAt`. Includes validateRegistry(next).
 * Rejects deleted history, reassignment, retroactive edits and any newly
 * introduced effective time earlier than the deployment.
 */
export function validateRegistryHistory(prev: ReferralRegistry, next: ReferralRegistry, deployedAt: number): string[] {
  const errors = validateRegistry(next);
  const prevLaunch = prev.launch?.blockNumber ?? null;
  if (prevLaunch !== null && next.launch?.blockNumber !== prevLaunch) errors.push("registry: the launch block is immutable once accepted");
  if (prev.chainId !== next.chainId) errors.push("registry: chainId is immutable");

  const byCode = new Map(next.codes.map((r) => [r.code, r]));
  const at = (iso: string) => `${iso} (deployment at ${new Date(deployedAt * 1000).toISOString().replace(".000Z", "Z")})`;
  const prospective = (label: string, field: string, iso: string | null) => {
    const s = secs(iso);
    if (iso !== null && s !== null && s < deployedAt) errors.push(`${label}: ${field} ${at(iso)} is earlier than this revision's deployment; reschedule it through review`);
  };

  for (const old of prev.codes) {
    const label = `code ${JSON.stringify(old.code)}`;
    const cur = byCode.get(old.code);
    if (!cur) {
      errors.push(`${label}: deleted; registry history is never removed`);
      continue;
    }
    if (beneficiaryKey(cur.beneficiary) !== beneficiaryKey(old.beneficiary)) errors.push(`${label}: reassigned to another beneficiary; codes are never reassigned`);
    if (JSON.stringify(cur.display) !== JSON.stringify(old.display)) errors.push(`${label}: display snapshot changed; it is fixed at issue time`);

    const oldEn = secs(old.enabledAt);
    const startedOrPast = oldEn !== null && oldEn <= deployedAt;
    if (old.enabledAt !== cur.enabledAt) {
      if (startedOrPast || old.cancelledAt !== null) errors.push(`${label}: activation is immutable once it has taken effect or been cancelled`);
      else if (cur.enabledAt === null) errors.push(`${label}: a scheduled activation is cancelled with cancelledAt, not removed`);
      else prospective(label, "enabledAt", cur.enabledAt);
    }
    if (old.termsVersion !== cur.termsVersion && startedOrPast) errors.push(`${label}: terms are immutable once the code is active`);
    if (old.cancelledAt !== cur.cancelledAt) {
      if (old.cancelledAt !== null) errors.push(`${label}: a cancellation is immutable`);
      else if (startedOrPast) errors.push(`${label}: only a scheduled activation can be cancelled`);
      else prospective(label, "cancelledAt", cur.cancelledAt);
    }
    if (old.disabledAt !== cur.disabledAt) {
      const oldDis = secs(old.disabledAt);
      if (oldDis !== null && oldDis <= deployedAt) errors.push(`${label}: a disable that has taken effect is immutable`);
      else if (cur.disabledAt === null) errors.push(`${label}: a recorded disable cannot be removed`);
      else prospective(label, "disabledAt", cur.disabledAt);
    }
  }

  const prevCodes = new Set(prev.codes.map((r) => r.code));
  for (const r of next.codes) {
    if (prevCodes.has(r.code)) continue;
    const label = `code ${JSON.stringify(r.code)}`;
    prospective(label, "enabledAt", r.enabledAt);
    prospective(label, "disabledAt", r.disabledAt);
    prospective(label, "cancelledAt", r.cancelledAt);
  }
  return errors;
}

/**
 * The record the admin member page shows (spec §5): the code active now; else
 * the nearest scheduled activation; else the most recently disabled; else a
 * draft. Code lexical order breaks otherwise equal ties.
 */
export function selectAdminRecord(records: readonly ReferralCodeRecord[], now: number): ReferralCodeRecord | null {
  const byCode = [...records].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const active = byCode.filter((r) => codeStateAt(r, now) === "active");
  if (active.length) return active[0]!;
  const scheduled = byCode.filter((r) => codeStateAt(r, now) === "scheduled");
  if (scheduled.length) return scheduled.reduce((best, r) => (secs(r.enabledAt)! < secs(best.enabledAt)! ? r : best));
  const disabled = byCode.filter((r) => codeStateAt(r, now) === "disabled");
  if (disabled.length) {
    const endOf = (r: ReferralCodeRecord) => secs(r.disabledAt) ?? secs(r.cancelledAt) ?? 0;
    return disabled.reduce((best, r) => (endOf(r) > endOf(best) ? r : best));
  }
  return byCode.find((r) => codeStateAt(r, now) === "draft") ?? null;
}

/** An empty registry: what the previous accepted revision is before any release carried one. */
export function emptyRegistry(): ReferralRegistry {
  return { schemaVersion: 1, chainId: REFERRAL_CHAIN_ID, launch: { blockNumber: null }, codes: [] };
}
