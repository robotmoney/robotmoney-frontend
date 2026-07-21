import * as ic from "../../committee/domain.ts";
import { sql } from "../../db/client.ts";
import { sendCommitteeActivationEmail } from "../../lib/email.ts";
import { SITE_PATHS, path as routePath } from "@robotmoney/contract";

export async function openSession(payload: Record<string, unknown>): Promise<unknown> {
  const date = String(payload.date ?? new Date().toISOString().slice(0, 10));
  const subjectId = payload.subjectId ? String(payload.subjectId) : await ic.subjectForDailySession(date);
  if (!subjectId) return { skipped: true, reason: "no active committee subject" };
  return await ic.openSession(date, subjectId);
}

async function resolveSessionId(payload: Record<string, unknown>, state: string): Promise<string | null> {
  return payload.sessionId ? String(payload.sessionId) : await ic.sessionIdForState(state);
}

export async function publishBrief(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = await resolveSessionId(payload, "scheduled");
  if (!sessionId) return { skipped: true, reason: "no scheduled committee session" };
  const windowMinutes = Number(payload.windowMinutes ?? 60);
  const prevOutcome = payload.prevOutcome ? String(payload.prevOutcome) : undefined;
  return await ic.publishBrief(sessionId, windowMinutes, prevOutcome);
}

export async function closeWindow(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = await resolveSessionId(payload, "collecting");
  if (!sessionId) return { skipped: true, reason: "no collecting committee session" };
  return await ic.closeWindow(sessionId);
}

export async function aggregateSession(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = await resolveSessionId(payload, "window_closed");
  if (!sessionId) return { skipped: true, reason: "no closed committee session" };
  return await ic.aggregateSession(sessionId);
}

export async function publishSession(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = await resolveSessionId(payload, "aggregated");
  if (!sessionId) return { skipped: true, reason: "no aggregated committee session" };
  return await ic.publishSession(sessionId);
}

export async function sendActivationEmail(payload: Record<string, unknown>): Promise<unknown> {
  const memberId = String(payload.memberId ?? "").trim();
  if (!memberId) throw new Error("committee.activation_email requires memberId");
  const member = (await sql<{ name: string; contact_email: string | null; status: string }[]>`
    SELECT name, contact_email, status FROM committee_members WHERE id = ${memberId}`)[0];
  if (!member || member.status !== "active") throw new Error(`active committee member not found: ${memberId}`);
  return sendCommitteeActivationEmail({
    memberId,
    name: member.name,
    recipient: member.contact_email || "",
    statusUrl: routePath(SITE_PATHS.committeeApplication, { member: memberId }),
  });
}
