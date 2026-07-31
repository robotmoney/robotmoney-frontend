import * as ic from "../../committee/domain.ts";
import { deliverSwarmNotification } from "../../committee/notifications.ts";

export async function openSession(payload: Record<string, unknown>): Promise<unknown> {
  // `payload.date` is deliberately IGNORED (and no longer defaulted from this
  // process's clock): since migration 0022 the session's date is derived from
  // the convened_at that Postgres stamps on insert. A queued job that has sat
  // in the queue across midnight must file its session under the day it
  // actually ran, not the day it was enqueued.
  const subjectId = String(payload.subjectId ?? "");
  return await ic.openSession(subjectId);
}

export async function publishBrief(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = String(payload.sessionId);
  const windowMinutes = Number(payload.windowMinutes ?? 60);
  const prevOutcome = payload.prevOutcome ? String(payload.prevOutcome) : undefined;
  return await ic.publishBrief(sessionId, windowMinutes, prevOutcome);
}

export async function closeWindow(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = String(payload.sessionId);
  return await ic.closeWindow(sessionId);
}

export async function aggregateSession(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = String(payload.sessionId);
  return await ic.aggregateSession(sessionId);
}

export async function publishSession(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = String(payload.sessionId);
  return await ic.publishSession(sessionId);
}

export async function sendActivationNotification(payload: Record<string, unknown>): Promise<unknown> {
  const outboxId = String(payload.outboxId ?? "");
  if (!outboxId) throw new Error("swarm activation notification requires outboxId");
  return deliverSwarmNotification(outboxId);
}

export async function sendSeatOpenNotification(payload: Record<string, unknown>): Promise<unknown> {
  const outboxId = String(payload.outboxId ?? "");
  if (!outboxId) throw new Error("swarm seat open notification requires outboxId");
  return deliverSwarmNotification(outboxId);
}

