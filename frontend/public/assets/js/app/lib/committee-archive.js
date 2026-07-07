// @ts-nocheck
export const COMMITTEE_ARCHIVE_ROOT = "/data/committee";

export function createCommitteeArchiveClient({ root = COMMITTEE_ARCHIVE_ROOT, fetcher = globalThis.fetch } = {}) {
  async function json(path) {
    if (!fetcher) throw new Error("fetch is not available for committee archive data");
    const res = await fetcher(`${root}${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  async function maybeJson(path) {
    try {
      return await json(path);
    } catch {
      return null;
    }
  }

  return { json, maybeJson };
}

function memberKey(value) {
  return value?.member_id || value?.memberId || value?.id || value;
}

export function normalizeCommitteeSession(session, brief = null) {
  const subject = brief?.subject || {};
  const recommendation = session.committee_recommendation || session.committeeRecommendation || null;
  return {
    date: session.date,
    subjectId: session.subject_id || session.subjectId,
    subjectName: session.subject_name || session.subjectName || subject.name,
    state: session.state || "published",
    regimeSummary: session.regime_summary || session.regimeSummary || brief?.regime || null,
    subjectSnapshotTotalValueUsd: session.subject_snapshot_total_value_usd || brief?.subject_snapshot?.total_value_usd,
    committeeRecommendation: recommendation,
    synthesis: session.synthesis || "",
    takes: (session.takes || []).map((take, index) => ({
      id: take.id || `${session.date}-${memberKey(take) || index}`,
      memberId: memberKey(take),
      memberName: take.member_name || take.memberName,
      stance: take.stance || "neutral",
      confidence: Number(take.confidence || 0),
      body: take.body || "",
      memoUrl: take.memo_url || take.memoUrl || "",
      verified: take.verified !== false,
    })),
    subject,
    brief,
  };
}

export function committeePositionRows(brief) {
  const raw = brief?.subject_snapshot?.positions || brief?.positions || brief?.portfolio?.positions || [];
  const total = Number(brief?.subject_snapshot?.total_value_usd || brief?.portfolio?.total_value_usd || 0);
  return raw
    .map((position) => {
      const value = Number(position.value_usd || position.valueUsd || position.usd || 0);
      return {
        token: position.token || position.symbol || position.asset || "asset",
        chain: position.chain || position.network || "-",
        valueUsd: value,
        share: Number(position.share || position.weight || (total > 0 ? value / total : 0)),
      };
    })
    .sort((a, b) => b.valueUsd - a.valueUsd);
}

export async function loadArchivedCommitteeSession(client, date, subjectId) {
  const [session, brief, memberIndex] = await Promise.all([
    client.json(`/sessions/${date}-${subjectId}.json`),
    client.maybeJson(`/briefs/${date}-${subjectId}.json`),
    client.maybeJson("/manifests/members/_index.json"),
  ]);
  const normalized = normalizeCommitteeSession(session, brief);
  const ids = (memberIndex?.members || ["athena", "robotmoney", "woon"]).map(memberKey);
  const members = (await Promise.all(ids.map((id) => client.maybeJson(`/manifests/members/${id}.json`)))).filter(Boolean);
  return {
    session: normalized,
    subject: normalized.subject,
    brief: normalized.brief,
    members,
    takes: normalized.takes,
    positionRows: committeePositionRows(brief),
    recommendationActions: normalized.committeeRecommendation?.actions || [],
    disagreements: normalized.committeeRecommendation?.disagreements || [],
    synthesis: normalized.synthesis,
  };
}

export async function loadArchivedCommitteeMember(client, memberId) {
  const [member, index] = await Promise.all([
    client.json(`/manifests/members/${memberId}.json`),
    client.maybeJson("/sessions/index.json"),
  ]);
  const refs = (index?.sessions || []).filter((session) => session.file).slice(0, 40);
  const sessions = (await Promise.all(refs.map((ref) => client.maybeJson(`/sessions/${ref.file}`))))
    .filter(Boolean)
    .filter((session) => (session.takes || []).some((take) => memberKey(take) === memberId))
    .slice(0, 10);
  const takes = sessions.map((session) => {
    const take = (session.takes || []).find((candidate) => memberKey(candidate) === memberId) || {};
    return {
      date: session.date,
      subjectId: session.subject_id || session.subjectId,
      subjectName: session.subject_name || session.subjectName,
      stance: take.stance,
      confidence: take.confidence,
      body: take.body,
    };
  });
  return { member, sessions, takes };
}
