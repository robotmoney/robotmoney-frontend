#!/usr/bin/env bash
# Docs-consistency guard for the analytics data seam (issue #22).
#
# The analytics source selector moved from the retired `PROVIDER=live` /
# per-run selector module to `ANALYTICS_SOURCE` + resolveAnalyticsSource()
# (backend/src/analytics/index.ts) over access/data-source.ts. This check fails
# LOUDLY if docs/ARCHITECTURE.md drifts back to the stale model, or if the
# authoritative knob / backtest+correlations surface stops being documented, so
# a stale selector term cannot silently return. It executes in CI (integration
# job) and its exit code gates that job.
#
# Extended (issue #40) to also guard the allocation/vault-dashboard scope
# declaration and the new live vault-economics endpoint's documentation (see
# checks 6-7 below) — same "docs must track the shipped seam" mandate, just a
# second seam.
set -uo pipefail

# Resolve repo root so the check runs from anywhere (CI or local).
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

ARCH="docs/ARCHITECTURE.md"
DECISIONS="docs/DECISIONS.md"
ENV_EXAMPLE=".env.example"
SELECT_TS="backend/src/analytics/access/select.ts"

fail=0
err() { echo "FAIL: $*" >&2; fail=1; }

[ -f "$ARCH" ] || { echo "FAIL: $ARCH missing" >&2; exit 1; }
[ -f "$DECISIONS" ] || { echo "FAIL: $DECISIONS missing" >&2; exit 1; }
[ -f "$ENV_EXAMPLE" ] || { echo "FAIL: $ENV_EXAMPLE missing" >&2; exit 1; }

# 1. Stale `select.ts` reference must not survive once the file is deleted.
if [ ! -f "$SELECT_TS" ] && grep -nF 'select.ts' "$ARCH"; then
  err "$ARCH references select.ts but $SELECT_TS no longer exists (stale selector)."
fi

# 2. `PROVIDER=live` must not be presented as the analytics-source selector.
if grep -nF 'PROVIDER=live' "$ARCH"; then
  err "$ARCH references PROVIDER=live; ANALYTICS_SOURCE is the authoritative selector."
fi

# 3. The authoritative selector must be documented in the architecture doc...
grep -qF 'ANALYTICS_SOURCE' "$ARCH" || err "$ARCH does not document ANALYTICS_SOURCE."
grep -qF 'resolveAnalyticsSource' "$ARCH" || err "$ARCH does not document resolveAnalyticsSource()."
grep -qF 'data-source.ts' "$ARCH" || err "$ARCH does not document access/data-source.ts."

# 4. ...and in the primary env template.
grep -qF 'ANALYTICS_SOURCE' "$ENV_EXAMPLE" || err "$ENV_EXAMPLE does not document ANALYTICS_SOURCE."

# 5. The backtest + predictive-correlations surface must be documented.
grep -qi 'backtest' "$ARCH" || err "$ARCH does not document the backtest surface."
grep -qi 'correlations' "$ARCH" || err "$ARCH does not document the correlations surface."

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
grep -qF '/api/dashboards/vault-economics' "$ARCH" || err "$ARCH does not document the /api/dashboards/vault-economics endpoint."
grep -qF 'vault_share_price_history' "$ARCH" || err "$ARCH does not document the vault_share_price_history table."
grep -qF 'chain/vault-economics.ts' "$ARCH" || err "$ARCH does not document backend/src/chain/vault-economics.ts."

if [ "$fail" -ne 0 ]; then
  echo "check-docs-analytics: FAILED" >&2
  exit 1
fi
echo "check-docs-analytics: OK"
