#!/usr/bin/env bash
# Docs-consistency guard for the analytics data seam (issue #22).
#
# The analytics source selector moved from the retired `PROVIDER=live` /
# per-run selector module to `ANALYTICS_SOURCE` + resolveAnalyticsSource()
# (backend/src/analytics/index.ts) over access/data-source.ts. This check fails
# LOUDLY if docs/architecture.md drifts back to the stale model, or if the
# authoritative knob / backtest+correlations surface stops being documented, so
# a stale selector term cannot silently return. It executes in CI as the
# "Check docs/analytics consistency" step of repo-guards.yml, and its exit code
# gates that required job.
#
# Extended (issue #40) to also guard the allocation/vault-dashboard scope
# declaration and the new live vault-economics endpoint's documentation (see
# checks 6-7 below) — same "docs must track the shipped seam" mandate, just a
# second seam.
#
# Extended (issue 1765) with three drift guards (checks 8-10): the factor panel
# is in the composite (D89), production's regime timer is 3-hourly (D87), and
# every test file the analyst SDK requirements' success table names exists.
# Each failure prints the file and the offending text.
# scripts/tests/unit/check-docs-analytics.test.ts plants each violation in a
# throwaway repository and requires this script to refuse it.
set -uo pipefail

# Resolve repo root so the check runs from anywhere (CI or local).
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

ARCH_NAME="docs/architecture/*.md"
ARCH="$(mktemp)"
trap 'rm -f "$ARCH"' EXIT
cat docs/architecture/*.md > "$ARCH" 2>/dev/null
DECISIONS="docs/decisions.md"
ENV_EXAMPLE=".env.example"
SELECT_TS="backend/src/analytics/access/select.ts"

fail=0
err() { echo "FAIL: $*" >&2; fail=1; }

[ -s "$ARCH" ] || { echo "FAIL: $ARCH_NAME missing" >&2; exit 1; }
[ -f "$DECISIONS" ] || { echo "FAIL: $DECISIONS missing" >&2; exit 1; }
[ -f "$ENV_EXAMPLE" ] || { echo "FAIL: $ENV_EXAMPLE missing" >&2; exit 1; }

# 1. Stale `select.ts` reference must not survive once the file is deleted.
# Scoped to the analytics-domain path specifically, so other domains' own
# select.ts files (e.g. backend/src/projects/access/select.ts) don't trip
# this as a false positive.
if [ ! -f "$SELECT_TS" ] && grep -nE 'analytics/access/select\.ts' "$ARCH"; then
  err "$ARCH_NAME references select.ts but $SELECT_TS no longer exists (stale selector)."
fi

# 2. `PROVIDER=live` must not be presented as the analytics-source selector.
if grep -nF 'PROVIDER=live' "$ARCH"; then
  err "$ARCH_NAME references PROVIDER=live; ANALYTICS_SOURCE is the authoritative selector."
fi

# 3. The authoritative selector must be documented in the architecture doc...
grep -qF 'ANALYTICS_SOURCE' "$ARCH" || err "$ARCH_NAME does not document ANALYTICS_SOURCE."
grep -qF 'resolveAnalyticsSource' "$ARCH" || err "$ARCH_NAME does not document resolveAnalyticsSource()."
grep -qF 'data-source.ts' "$ARCH" || err "$ARCH_NAME does not document access/data-source.ts."

# 4. ...and in the primary env template.
grep -qF 'ANALYTICS_SOURCE' "$ENV_EXAMPLE" || err "$ENV_EXAMPLE does not document ANALYTICS_SOURCE."

# 5. The backtest + predictive-correlations surface must be documented.
grep -qi 'backtest' "$ARCH" || err "$ARCH_NAME does not document the backtest surface."
grep -qi 'correlations' "$ARCH" || err "$ARCH_NAME does not document the correlations surface."

# 6. Allocation/vault-dashboard scope (issue #40): if either doc still
# declares allocation/vault dashboards out of scope, that declaration must
# carry the superseding decision entry (D15) that brought the vault-economics
# slice into scope — otherwise a stale blanket exclusion could silently
# reappear (or be re-added) after the live pipeline shipped.
for doc in "$ARCH" "$DECISIONS"; do
  if grep -qiE 'allocation.{0,3}/.{0,3}vault.{0,3}/.{0,3}wallet dashboards' "$doc" \
     || grep -qiE 'vault dashboards? (is|are) out of scope' "$doc"; then
    grep -qF 'D15' "$doc" || err "$doc declares allocation/vault dashboards out of scope without the superseding D15 decision entry."
  fi
done
grep -qF 'D15' "$DECISIONS" || err "$DECISIONS does not contain the D15 (live vault-economics pipeline) decision entry."

# 7. The new vault-economics endpoint + its data model must be documented.
grep -qF '/api/dashboards/vault-economics' "$ARCH" || err "$ARCH_NAME does not document the /api/dashboards/vault-economics endpoint."
grep -qF 'vault_share_price_history' "$ARCH" || err "$ARCH_NAME does not document the vault_share_price_history table."
grep -qF 'chain/vault-economics.ts' "$ARCH" || err "$ARCH_NAME does not document backend/src/chain/vault-economics.ts."

# 8. The factor panel counts toward the composite (D89, issue 1708):
#    PANEL_MEMBERSHIP.factor is "included". The analytics requirements must not
#    call it display-only again. The doc is read with line wraps folded and cut
#    into sentences at ". ", "! ", "? " and table cell bars, so a sentence that
#    names the factor panel and "display-only" (or "display only") fails, in
#    any case and across a line wrap.
ANALYTICS_REQ="docs/technical/analytics-requirements.md"
if [ -f "$ANALYTICS_REQ" ]; then
  while IFS= read -r sentence; do
    [ -n "$sentence" ] || continue
    err "$ANALYTICS_REQ calls the factor panel display-only, but the composite includes it (D89): \"$sentence\""
  done < <(awk '
    { text = text " " $0 }
    END {
      n = split(text, parts, /[.!?][ \t]+|[|]/)
      for (i = 1; i <= n; i++) {
        s = parts[i]
        l = tolower(s)
        if (index(l, "factor") > 0 && l ~ /display[- ]only/) {
          gsub(/^[ \t]+|[ \t]+$/, "", s)
          print s
        }
      }
    }' "$ANALYTICS_REQ")
else
  err "$ANALYTICS_REQ missing"
fi

# 9. Production runs the regime timer at `30 */3 * * *` and research at
#    `0 */3 * * *` (D87, scripts/lib/smoke-cadence.ts). The committed default
#    is `30 22 * * *`. The task queue doc states cron expressions, so prose
#    giving a daily 22:30 regime timer is drift. Newlines are folded first, as
#    lint-docs.sh check 7 does, so a timer split over a line wrap is caught.
TASK_QUEUE="docs/architecture/task-queue-and-workers.md"
if [ -f "$TASK_QUEUE" ]; then
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    err "$TASK_QUEUE states a daily 22:30 regime timer, but production runs regime at \`30 */3 * * *\` (D87): \"$hit\""
  done < <(tr '\n' ' ' <"$TASK_QUEUE" | grep -oiE 'regime[^.]{0,80}daily at \**22:30' || true)
else
  err "$TASK_QUEUE missing"
fi

# 10. Every test file the analyst SDK requirements' success table (section 8)
#     names exists. Each backticked `*.ts` path in a table row resolves by its
#     prefix, as the section's path rule states: csvb `tests/...` from
#     packages/csvb/, backend `tests/...` from backend/, a path starting with
#     scripts/, backend/, packages/, contract/ or frontend/ from the repo root,
#     and any other path (tests/..., src/...) from packages/analyst-sdk/. A
#     backticked cell that is not a .ts path (a script name, a JSON file) is
#     skipped. A table with no .ts path at all fails, so a renamed section
#     cannot pass by checking nothing.
SDK_REQ="docs/technical/analyst-sdk-requirements.md"
if [ -f "$SDK_REQ" ]; then
  named_count=0
  while IFS=$'\t' read -r named path; do
    [ -n "$path" ] || continue
    named_count=$((named_count + 1))
    [ -f "$path" ] || err "$SDK_REQ section 8 names $named, which does not exist ($path)."
  done < <(awk '
    /^## 8\./ { on = 1; next }
    /^## / { on = 0 }
    on && /^[|]/ {
      line = $0
      while (match(line, /(csvb |backend )?`[^`]+`/)) {
        tok = substr(line, RSTART, RLENGTH)
        line = substr(line, RSTART + RLENGTH)
        prefix = ""
        if (tok ~ /^csvb /) { prefix = "csvb"; tok = substr(tok, 6) }
        else if (tok ~ /^backend /) { prefix = "backend"; tok = substr(tok, 9) }
        p = substr(tok, 2, length(tok) - 2)
        if (p !~ /^[A-Za-z0-9_.\/-]+[.]ts$/) continue
        if (prefix == "csvb") path = "packages/csvb/" p
        else if (prefix == "backend") path = "backend/" p
        else if (p ~ /^(scripts|backend|packages|contract|frontend)\//) path = p
        else path = "packages/analyst-sdk/" p
        print (prefix == "" ? "" : prefix " ") "`" p "`" "\t" path
      }
    }' "$SDK_REQ")
  [ "$named_count" -gt 0 ] || err "$SDK_REQ section 8 names no .ts test file; the success table is missing or renamed."
else
  err "$SDK_REQ missing"
fi

if [ "$fail" -ne 0 ]; then
  echo "check-docs-analytics: FAILED" >&2
  exit 1
fi
echo "check-docs-analytics: OK"
