// The swarm subject id of the allocation itself, in one place.
//
// `robotmoney-allocation` is a slug, not a uuid: it is the primary key of the
// framework subject in `swarm_subjects`, it appears in the session feed as
// `subjectId`, and it is the reader-facing URL of the subject's own page. Two
// surfaces need to agree about it — /allocation's link out to the sessions
// that review these weights, and the session filter — so it is a shared
// constant rather than a string typed out twice.
//
// It is matched by ID and never by `source.type === "framework"`: the type
// test needs every subject record fetched first, which is a request per
// subject before either page can draw a single row.
export const ALLOCATION_SUBJECT_ID = "robotmoney-allocation";

// The vault is a BOOK of holdings and keeps its own portfolio page (RM-114's
// rule). /allocation's Vault section links to it for the vault's own session
// record rather than reprinting it.
export const VAULT_SUBJECT_ID = "robotmoney-vault";

/** @param {{ subjectId?: string, state?: string } | null | undefined} s */
export function isPublishedAllocationSession(s) {
  return !!s && s.state === "published" && s.subjectId === ALLOCATION_SUBJECT_ID;
}
