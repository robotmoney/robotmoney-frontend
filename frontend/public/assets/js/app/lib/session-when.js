// When a session is shown as having happened (issue 1081).
//
// A session's `date` (and `generatedAt`) is when its ROW was created, in `scheduled`. A session that waits for its brief
// keeps that day: on 2026-09-28 four rows were created at 00:11 to 00:40 UTC and were briefed on 09-29 and 09-30. What a
// reader means by "when" is when the session OPENED (`openedAt`, the first brief revision), else when it published, and
// only for the archive, which carries neither, the date. `date` still names the session: it is in the URL and in what
// members sign, so links and ids keep using it.
/** @param {{ openedAt?: string | null, publishedAt?: string | null, date?: string | null } | null | undefined} s */
export function sessionWhen(s) {
  return s?.openedAt || s?.publishedAt || s?.date || "";
}
