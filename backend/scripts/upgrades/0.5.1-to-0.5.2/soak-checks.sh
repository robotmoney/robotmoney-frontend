#!/bin/bash
# v0.5.2 soak checks that prove the release's own claims (runbook R8.x). Read-only. Runs beside prod:gate at every soak gate.
# Usage: r8-checks.sh [T0]   (default: /root/r64-t0-v0.5.2.txt)
export PATH=/root/.bun/bin:$PATH
cd /root/robotmoney-frontend || exit 2
T0=${1:-$(cat /root/r64-t0-v0.5.2.txt)}
M="$(grep -m1 '^MIGRATE_DATABASE_URL=' .env | cut -d= -f2-)"
export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000'
BASE_MB=963          # database size right after the cutover (2026-09-29 23:08Z)
ANALYSTS_BASELINE=7
FAILS=0; WARNS=0
q() { psql "$M" -X -At -F '|' "$@" 2>&1; }
ck() { # level name detail
  case "$1" in FAIL) FAILS=$((FAILS+1));; WARN) WARNS=$((WARNS+1));; esac
  printf '  [%s] %s: %s\n' "$1" "$2" "$3"
}
now=$(date +%s); t0s=$(date -d "$T0" +%s)
hours=$(( (now - t0s) / 3600 ))
echo "== R8 checks $(date -u +%FT%TZ)  (T0=$T0, +${hours}h)"

# R8.a / R8.b  scheduled regime (:30) and research (:00) runs, every 3 h, each must have produced its output artifact
slots() { minute=$1; d0=$(date -u -d "$T0" +%F)
  for dd in 0 1 2; do day=$(date -u -d "$d0 +$dd day" +%F)
    for h in 0 3 6 9 12 15 18 21; do
      ts=$(date -u -d "$day $(printf %02d $h):$minute:00" +%s)
      [ "$ts" -ge "$t0s" ] && [ "$ts" -le $((now - 1200)) ] && echo "$ts"
    done; done; }
cadence() { tool=$1; minute=$2; artifact=$3; label=$4
  total=0; ok=0; missing=""
  for ts in $(slots "$minute"); do
    total=$((total+1))
    r=$(q -c "SELECT count(*) FROM analytics_ledger_runs r WHERE r.tool_id = '$tool' AND r.created_at >= to_timestamp($ts) AND r.created_at < to_timestamp($ts) + interval '20 minutes' AND EXISTS (SELECT 1 FROM analytics_output_snapshots o WHERE o.run_id = r.id AND o.artifact_kind = '$artifact')")
    if [ "$r" -ge 1 ] 2>/dev/null; then ok=$((ok+1)); else missing="$missing $(date -u -d @$ts +%H:%M)"; fi
  done
  if [ "$total" = 0 ]; then ck INFO "$label" "no scheduled slot has elapsed yet"
  elif [ "$ok" = "$total" ]; then ck PASS "$label" "$ok of $total scheduled runs produced their output"
  else ck FAIL "$label" "$ok of $total scheduled runs produced output; missing slots (UTC):$missing"; fi; }
# A SUCCEEDED terminal package holds regime_snapshots AND research_signals whichever tool ran it; a failed one holds
# warnings, logs and exceptions only (under v0.5.1 all 42 runs from 09-28 18:30 to 09-29 20:31 were the failed kind).
cadence regime 30 regime_snapshots "R8.a regime runs on the 3 h cron (:30)"
cadence research 0 regime_snapshots "R8.b research runs on the 3 h cron (:00)"
f=$(docker logs --since "$T0" rm_prod-analytics-producer-1 2>&1 | grep -a -c -E 'regime failed|research failed|analytics-producer\] fatal:|catch-up for .* failed')
[ "$f" = 0 ] && ck PASS "R8.c producer failure lines since T0" "0" || ck FAIL "R8.c producer failure lines since T0" "$f (regime/research failed, fatal, or catch-up failed)"

# R8.d  ledger growth
size=$(q -c "SELECT (pg_database_size(current_database()) / 1048576)::int")
grow=$(( size - BASE_MB )); allow=$(( 100 * (hours / 6 + 1) ))
[ "$grow" -le "$allow" ] && ck PASS "R8.d database size" "${size} MB (${grow} MB since the cutover; limit ${allow} MB; v0.5.1 grew about 470 MB per 6 h)" \
                          || ck FAIL "R8.d database size" "${size} MB (+${grow} MB since the cutover; limit ${allow} MB)"

# R8.e  the writers record only real changes: no noise-only revisions, no 'unchanged' rows, since T0
r=$(q -c "WITH v AS (SELECT s.source_key, s.value, s.revision_kind, p.value AS pv FROM source_value_versions s LEFT JOIN source_value_versions p ON p.id = s.prior_version_id WHERE s.knowledge_time >= '$T0'::timestamptz)
          SELECT count(*) || '|' || count(*) FILTER (WHERE revision_kind = 'unchanged') || '|' || count(*) FILTER (WHERE revision_kind = 'revision' AND pv IS NOT NULL AND abs(value - pv) <= (CASE WHEN source_key ~ '(COPPER_GOLD|IWM_SPY|BTC_ETH|SPHB_SPLV|MTUM_SPY|IWF_IWD|XLU_SPY|XLP_XLY)\$' THEN 5e-6 WHEN source_key ~ ':(VIX|SPX_TREND|ETH_TREND)\$' OR source_key ~ '^(research|backtest):' AND source_key !~ ':(CONF|MARGIN|DTB3)\$' THEN 1e-6 ELSE 0 END) * greatest(abs(value), abs(pv)) AND value <> pv) FROM v")
IFS='|' read -r n unch noise <<< "$r"
[ "${unch:-x}" = 0 ] && [ "${noise:-x}" = 0 ] && ck PASS "R8.e ledger versions written since T0" "$n rows; 0 'unchanged'; 0 noise-only revisions" \
                                              || ck FAIL "R8.e ledger versions written since T0" "$n rows; unchanged=$unch noise-only=$noise (raw: $r)"

# R8.f  parity sweeps: succeed, none dead, durations near the baseline (baseline p50 126 s, max 175 s)
r=$(q -c "SELECT count(*) FILTER (WHERE status = 'succeeded') || '|' || count(*) FILTER (WHERE status = 'dead') || '|' || coalesce(round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM updated_at - created_at)) FILTER (WHERE status = 'succeeded'))::numeric), 0) || '|' || coalesce(round(max(extract(epoch FROM updated_at - created_at)) FILTER (WHERE status = 'succeeded')::numeric), 0) FROM jobs WHERE kind = 'analytics.parity_sweep' AND created_at >= '$T0'::timestamptz")
IFS='|' read -r okn dead p50 mx <<< "$r"
if [ "${dead:-1}" != 0 ]; then ck FAIL "R8.f parity sweeps" "$dead dead, $okn succeeded"
elif [ "${mx:-999}" -gt 300 ]; then ck FAIL "R8.f parity sweeps" "max duration ${mx}s exceeds the api's 5 min statement timeout"
elif [ "${p50:-999}" -gt 126 ]; then ck WARN "R8.f parity sweeps" "$okn succeeded, p50 ${p50}s is above the v0.5.1 baseline 126 s"
else ck PASS "R8.f parity sweeps" "$okn succeeded, 0 dead, p50 ${p50}s, max ${mx}s (baseline p50 126 s)"; fi

# R8.g  website server errors (baseline 288 per 24 h)
n5=$(docker logs --since "$T0" rm_prod-website-server-1 2>&1 | grep -a -c -E '" 5[0-9][0-9] ')
if [ "$n5" = 0 ]; then ck PASS "R8.g website 5xx since T0" "0 (v0.5.1: 288 per 24 h)"
elif [ "$n5" -le 10 ]; then ck WARN "R8.g website 5xx since T0" "$n5"; else ck FAIL "R8.g website 5xx since T0" "$n5"; fi

# R8.h  quorum excludes the judge; R8.i  every published session since T0 has takes, a judgement and a receipt
act=$(q -c "SELECT count(*) FROM swarm_members WHERE status = 'active' AND role = 'member'")
r=$(q -c "SELECT count(*) || '|' || count(*) FILTER (WHERE (swarm_recommendation->'quorum'->>'active')::int <> $act) FROM swarm_sessions WHERE state = 'published' AND published_at >= '$T0'::timestamptz")
IFS='|' read -r np badq <<< "$r"
if [ "$np" = 0 ]; then ck INFO "R8.h quorum vs analysts" "no session published since T0 yet ($act active analysts)"
elif [ "$badq" = 0 ]; then ck PASS "R8.h quorum vs analysts" "$np published session(s) show quorum = $act active analysts (v0.5.1 showed 8)"
else ck FAIL "R8.h quorum vs analysts" "$badq of $np published session(s) have quorum <> $act"; fi
r=$(q -c "SELECT count(*) FILTER (WHERE t < 1) || '|' || count(*) FILTER (WHERE j < 1) || '|' || count(*) FILTER (WHERE c < 1) FROM (SELECT (SELECT count(*) FROM swarm_recommendations r WHERE r.session_id = s.id) t, (SELECT count(*) FROM swarm_session_judgements j WHERE j.session_id = s.id) j, (SELECT count(*) FROM swarm_consensus_receipts c WHERE c.session_id = s.id) c FROM swarm_sessions s WHERE s.state = 'published' AND s.published_at >= '$T0'::timestamptz) x")
IFS='|' read -r nt nj nc <<< "$r"
if [ "$np" = 0 ]; then ck INFO "R8.i published sessions complete" "none published since T0 yet"
elif [ "$nt$nj$nc" = "000" ]; then ck PASS "R8.i published sessions complete" "all $np have takes, a judgement and a receipt"
else ck FAIL "R8.i published sessions complete" "of $np: $nt without takes, $nj without a judgement, $nc without a receipt"; fi
r=$(q -c "SELECT string_agg(subject_id || ' ' || state, ', ' ORDER BY subject_id) FROM swarm_sessions WHERE id IN ('c1d96ce7-05bc-4d50-b193-ef53502dccbf','16113cf1-cd65-46ab-9d9d-2b391b59b997','12a04ae6-9d4e-4462-ac62-85d3800b8139','551f94d8-6fc4-4e64-a26d-a5c8f14de219')")
ck INFO "R8.j the 4 sessions stuck before the cutover (must all end 'published' by +24 h)" "$r"

# R8.k  every guard the repair disarmed is armed again (ENABLE ALWAYS = 'A')
r=$(q -c "SELECT count(*) || '|' || count(*) FILTER (WHERE tgenabled = 'A') FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('source_value_versions_immutable','source_value_versions_immutable_row','analytics_vintage_members_immutable','analytics_vintage_members_immutable_row','analytics_overwrite_events_append_only','analytics_overwrite_events_append_only_row','analytics_overwrite_events_immutable','analytics_overwrite_events_immutable_row','raw_indicator_history_capture_overwrite','analytics_data_vintages_immutable','analytics_data_vintages_immutable_row')")
IFS='|' read -r tn ta <<< "$r"
[ "$tn" = 11 ] && [ "$ta" = 11 ] && ck PASS "R8.k ledger guards" "11 of 11 triggers ENABLE ALWAYS" || ck FAIL "R8.k ledger guards" "$ta of $tn (expected 11 of 11) triggers armed"

# R8.l  the newest vintage still resolves to its recorded member count
r=$(q -c "WITH v AS (SELECT id, member_count FROM analytics_data_vintages ORDER BY id DESC LIMIT 1) SELECT v.id || '|' || v.member_count || '|' || (SELECT count(*) FROM analytics_vintage_members vm CROSS JOIN LATERAL generate_series(vm.source_value_version_id, COALESCE(vm.last_source_value_version_id, vm.source_value_version_id)) g(id) JOIN source_value_versions s ON s.id = g.id AND s.source_key = vm.source_key WHERE vm.vintage_id = v.id) FROM v")
IFS='|' read -r vid vmc vres <<< "$r"
[ "$vmc" = "$vres" ] && ck PASS "R8.l newest vintage integrity" "vintage $vid resolves to $vres members = member_count" || ck FAIL "R8.l newest vintage integrity" "vintage $vid: member_count $vmc, resolves to $vres"

# R8.m  no connection-pool starvation (the issue 1035 mechanism): sessions idle in a transaction for over a minute
r=$(q -c "SELECT count(*) FILTER (WHERE state = 'idle in transaction' AND now() - state_change > interval '60 seconds') || '|' || count(*) FROM pg_stat_activity WHERE datname = current_database()")
IFS='|' read -r iit conns <<< "$r"
[ "$iit" = 0 ] && ck PASS "R8.m connections" "$conns open, 0 idle in a transaction over 60 s" || ck FAIL "R8.m connections" "$iit idle in a transaction over 60 s ($conns open)"

# R8.n  host disk (9.5 GB free at the cutover)
free=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
[ "$free" -ge 5 ] && ck PASS "R8.n host disk free" "${free} GB" || { [ "$free" -ge 3 ] && ck WARN "R8.n host disk free" "${free} GB" || ck FAIL "R8.n host disk free" "${free} GB"; }

# R8.o  informational: error-like lines per container since T0 (the gate classifies them; this is the raw count)
for c in $(docker ps --format '{{.Names}}' | grep '^rm_prod-'); do
  e=$(docker logs --since "$T0" "$c" 2>&1 | grep -a -v RM_TELEMETRY | grep -a -c -iE 'error|fatal|refus|denied|timed out|exception|panic')
  printf '  [INFO] R8.o %s: %s error-like lines since T0\n' "${c#rm_prod-}" "$e"
done
echo "== R8 checks result: $FAILS FAIL, $WARNS WARN"
[ "$FAILS" = 0 ]
