#!/bin/bash
# CUMULATIVE standing-invariant checks for every 0.5.x release (runbook R2.x baseline, R4.x twin, R7.x postflight, R8.x watch).
# Read-only. Ported from 0.5.1-to-0.5.2/soak-checks.sh (R8.a-R8.o) and extended with the standing checks of v0.5.0 to v0.5.3
# and the claims of v0.5.4 (R8.p-R8.y). Runs beside prod:gate / twin:gate at every gate.
#
#   soak-checks.sh T0                        (production, from a scratch clone: PROJECT=rm_prod)
#   PROJECT=rm_smoke_stack_xxx BASE_URL=http://127.0.0.1:48787 soak-checks.sh T0   (a twin)
#   R8_RECORD=1 soak-checks.sh T0            record the baseline (schema_migrations list, db size) in $R8_STATE, then check
#
# T0 is an ISO instant (the moment the stack under test became READY).
export PATH=/root/.bun/bin:$HOME/.bun/bin:$PATH
PROJECT=${PROJECT:-rm_prod}
BASE_URL=${BASE_URL:-https://robotmoney.network}
C=$PROJECT-api-1
T0=${1:?usage: soak-checks.sh T0-ISO-instant}
R8_STATE=${R8_STATE:-$HOME/.r8-$PROJECT}
mkdir -p "$R8_STATE"
FULL=${R8_FULL:-0}   # 1 at gates: also run the slow full vintage join (about 2 min on production)
ANALYSTS_BASELINE=7
FAILS=0; WARNS=0
QERRFILE=$(mktemp); trap 'rm -f "$QERRFILE"' EXIT
# Queries run through the api container (it already holds the connection; no credential is read). `q -c SQL` prints the first
# column of every row. A query that errors must never read as a pass: an ERROR line is counted and fails R8.z.
q() { local sql="${2:-$1}" out
  out=$(docker exec "$C" bun -e 'import postgres from "postgres"; const sql = postgres(process.env.DATABASE_URL, { max: 1, connection: { default_transaction_read_only: "on", statement_timeout: 60000 } }); try { const rows = await sql.unsafe(process.argv[1]); for (const r of rows) console.log(Object.values(r)[0]); } catch (e) { console.log("ERROR: " + e.message); } process.exit(0)' "$sql" 2>&1)
  case "$out" in *ERROR:*) echo x >> "$QERRFILE";; esac; printf '%s\n' "$out"; }
ck() { case "$1" in FAIL) FAILS=$((FAILS+1));; WARN) WARNS=$((WARNS+1));; esac; printf '  [%s] %s: %s\n' "$1" "$2" "$3"; }
now=$(date +%s); t0s=$(date -d "$T0" +%s)
hours=$(( (now - t0s) / 3600 ))
echo "== soak checks $(date -u +%FT%TZ)  (project $PROJECT, T0=$T0, +${hours}h)"

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
cadence regime 30 regime_snapshots "R8.a regime runs on the 3 h cron (:30)"
cadence research 0 regime_snapshots "R8.b research runs on the 3 h cron (:00)"
f=$(docker logs --since "$T0" "$PROJECT-analytics-producer-1" 2>&1 | grep -a -c -E 'regime failed|research failed|analytics-producer\] fatal:|catch-up for .* failed')
[ "$f" = 0 ] && ck PASS "R8.c producer failure lines since T0" "0" || ck FAIL "R8.c producer failure lines since T0" "$f (regime/research failed, fatal, or catch-up failed)"

# R8.d  ledger growth. Baseline: the size at the first run with R8_RECORD=1 (R2 on production, READY on a twin).
size=$(q -c "SELECT (pg_database_size(current_database()) / 1048576)::int")
if [ "${R8_RECORD:-0}" = 1 ]; then echo "$size" > "$R8_STATE/base-mb"; fi
BASE_MB=$(cat "$R8_STATE/base-mb" 2>/dev/null || echo "$size")
grow=$(( size - BASE_MB )); allow=$(( 100 * (hours / 6 + 1) ))
[ "$grow" -le "$allow" ] && ck PASS "R8.d database size" "${size} MB (${grow} MB since the baseline ${BASE_MB} MB; limit ${allow} MB)" \
                          || ck FAIL "R8.d database size" "${size} MB (+${grow} MB since the baseline ${BASE_MB} MB; limit ${allow} MB)"

# R8.e  the writers record only real changes: no noise-only revisions, no 'unchanged' rows, since T0
r=$(q -c "WITH v AS (SELECT s.source_key, s.value, s.revision_kind, p.value AS pv FROM source_value_versions s LEFT JOIN source_value_versions p ON p.id = s.prior_version_id WHERE s.knowledge_time >= '$T0'::timestamptz)
          SELECT count(*) || '|' || count(*) FILTER (WHERE revision_kind = 'unchanged') || '|' || count(*) FILTER (WHERE revision_kind = 'revision' AND pv IS NOT NULL AND abs(value - pv) <= (CASE WHEN source_key ~ '(COPPER_GOLD|IWM_SPY|BTC_ETH|SPHB_SPLV|MTUM_SPY|IWF_IWD|XLU_SPY|XLP_XLY)\$' THEN 5e-6 WHEN source_key ~ ':(VIX|SPX_TREND|ETH_TREND)\$' OR source_key ~ '^(research|backtest):' AND source_key !~ ':(CONF|MARGIN|DTB3)\$' THEN 1e-6 ELSE 0 END) * greatest(abs(value), abs(pv)) AND value <> pv) FROM v")
IFS='|' read -r n unch noise <<< "$r"
[ "${unch:-x}" = 0 ] && [ "${noise:-x}" = 0 ] && ck PASS "R8.e ledger versions written since T0" "$n rows; 0 'unchanged'; 0 noise-only revisions" \
                                              || ck FAIL "R8.e ledger versions written since T0" "$n rows; unchanged=$unch noise-only=$noise (raw: $r)"

# R8.f  parity sweeps: none dead, max under 300 s (the api statement timeout), p50 at or under the baseline 126 s.
# v0.5.4: the api request limit is an explicit 10 s; a sweep request cut off there is issue 1079's known cause (WARN, never hidden).
r=$(q -c "SELECT count(*) FILTER (WHERE status = 'succeeded') || '|' || count(*) FILTER (WHERE status = 'dead') || '|' || coalesce(round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM updated_at - created_at)) FILTER (WHERE status = 'succeeded'))::numeric), 0) || '|' || coalesce(round(max(extract(epoch FROM updated_at - created_at)) FILTER (WHERE status = 'succeeded')::numeric), 0) FROM jobs WHERE kind = 'analytics.parity_sweep' AND created_at >= '$T0'::timestamptz")
IFS='|' read -r okn dead p50 mx <<< "$r"
if [ "${dead:-1}" != 0 ]; then ck FAIL "R8.f parity sweeps" "$dead dead, $okn succeeded"
elif [ "${mx:-999}" -gt 300 ]; then ck FAIL "R8.f parity sweeps" "max duration ${mx}s exceeds the api's 5 min statement timeout"
elif [ "${p50:-999}" -gt 126 ]; then ck WARN "R8.f parity sweeps" "$okn succeeded, p50 ${p50}s is above the v0.5.1 baseline 126 s"
else ck PASS "R8.f parity sweeps" "$okn succeeded, 0 dead, p50 ${p50}s, max ${mx}s (baseline p50 126 s)"; fi

# R8.g  website server errors: 0 passes, up to 10 warns. Counts requests since T0 and nginx [error] lines.
n5=$(docker logs --since "$T0" "$PROJECT-website-server-1" 2>&1 | grep -a -c -E '" 5[0-9][0-9] ')
ne=$(docker logs --since "$T0" "$PROJECT-website-server-1" 2>&1 | grep -a -c '\[error\]')
if [ "$n5" = 0 ] && [ "$ne" = 0 ]; then ck PASS "R8.g website 5xx and [error] since T0" "0"
elif [ "$n5" -le 10 ]; then ck WARN "R8.g website 5xx and [error] since T0" "5xx=$n5 [error]=$ne"; else ck FAIL "R8.g website 5xx and [error] since T0" "5xx=$n5 [error]=$ne"; fi

# R8.h  quorum excludes the judge; R8.i  every published session since T0 has takes, a judgement and a receipt
act=$(q -c "SELECT count(*) FROM swarm_members WHERE status = 'active' AND role = 'member'")
r=$(q -c "SELECT count(*) || '|' || count(*) FILTER (WHERE (swarm_recommendation->'quorum'->>'active')::int <> $act) FROM swarm_sessions WHERE state = 'published' AND published_at >= '$T0'::timestamptz")
IFS='|' read -r np badq <<< "$r"
if [ "$np" = 0 ]; then ck INFO "R8.h quorum vs analysts" "no session published since T0 yet ($act active analysts)"
elif [ "$badq" = 0 ]; then ck PASS "R8.h quorum vs analysts" "$np published session(s) show quorum = $act active analysts"
else ck FAIL "R8.h quorum vs analysts" "$badq of $np published session(s) have quorum <> $act"; fi
r=$(q -c "SELECT count(*) FILTER (WHERE t < 1) || '|' || count(*) FILTER (WHERE j < 1) || '|' || count(*) FILTER (WHERE c < 1) FROM (SELECT (SELECT count(*) FROM swarm_recommendations r WHERE r.session_id = s.id) t, (SELECT count(*) FROM swarm_session_judgements j WHERE j.session_id = s.id) j, (SELECT count(*) FROM swarm_consensus_receipts c WHERE c.session_id = s.id) c FROM swarm_sessions s WHERE s.state = 'published' AND s.published_at >= '$T0'::timestamptz) x")
IFS='|' read -r nt nj nc <<< "$r"
if [ "$np" = 0 ]; then ck INFO "R8.i published sessions complete" "none published since T0 yet"
elif [ "$nt$nj$nc" = "000" ]; then ck PASS "R8.i published sessions complete" "all $np have takes, a judgement and a receipt"
else ck FAIL "R8.i published sessions complete" "of $np: $nt without takes, $nj without a judgement, $nc without a receipt"; fi
# R8.j  no session is wedged: none still open past its window plus a 30 minute grace
w=$(q -c "SELECT count(*) FROM swarm_sessions WHERE state IN ('scheduled','collecting') AND window_closes_at < now() - interval '30 minutes'")
[ "$w" = 0 ] && ck PASS "R8.j no wedged session" "0 open past their window + 30 min" || ck FAIL "R8.j no wedged session" "$w open past their window + 30 min"

# R8.k  every ledger guard is armed (ENABLE ALWAYS = 'A'); R8.k2 the old payload table stays gone (issue 1035)
r=$(q -c "SELECT count(*) || '|' || count(*) FILTER (WHERE tgenabled = 'A') FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('source_value_versions_immutable','source_value_versions_immutable_row','analytics_vintage_members_immutable','analytics_vintage_members_immutable_row','analytics_overwrite_events_append_only','analytics_overwrite_events_append_only_row','analytics_overwrite_events_immutable','analytics_overwrite_events_immutable_row','raw_indicator_history_capture_overwrite','analytics_data_vintages_immutable','analytics_data_vintages_immutable_row')")
IFS='|' read -r tn ta <<< "$r"
[ "$tn" = 11 ] && [ "$ta" = 11 ] && ck PASS "R8.k ledger guards" "11 of 11 triggers ENABLE ALWAYS" || ck FAIL "R8.k ledger guards" "$ta of $tn (expected 11 of 11) triggers armed"
sp=$(q -c "SELECT coalesce(to_regclass('public.source_payloads')::text, 'absent')")
[ "$sp" = absent ] && ck PASS "R8.k2 source_payloads" "absent" || ck FAIL "R8.k2 source_payloads" "present: $sp"

# R8.l  the newest vintage: the run lengths add up to member_count; at gates (R8_FULL=1) also the full id join
r=$(q -c "WITH v AS (SELECT id, member_count FROM analytics_data_vintages ORDER BY id DESC LIMIT 1) SELECT v.id || '|' || v.member_count || '|' || (SELECT coalesce(sum(coalesce(vm.last_source_value_version_id - vm.source_value_version_id + 1, 1)), 0) FROM analytics_vintage_members vm WHERE vm.vintage_id = v.id) FROM v")
IFS='|' read -r vid vmc vsum <<< "$r"
if ! [[ "$vid$vmc$vsum" =~ ^[0-9]+$ ]]; then ck FAIL "R8.l newest vintage integrity" "could not be read: ${r:0:100}"
elif [ "$vmc" != "$vsum" ]; then ck FAIL "R8.l newest vintage integrity" "vintage $vid: member_count $vmc but its runs cover $vsum ids"
elif [ "$FULL" = 1 ]; then
  rj=$(q -c "SELECT count(*) FROM analytics_vintage_members vm CROSS JOIN LATERAL generate_series(vm.source_value_version_id, COALESCE(vm.last_source_value_version_id, vm.source_value_version_id)) g(id) JOIN source_value_versions s ON s.id = g.id AND s.source_key = vm.source_key WHERE vm.vintage_id = $vid")
  if ! [[ "$rj" =~ ^[0-9]+$ ]]; then ck FAIL "R8.l newest vintage integrity" "full join could not be read: ${rj:0:100}"
  elif [ "$rj" = "$vmc" ]; then ck PASS "R8.l newest vintage integrity" "vintage $vid: all $rj ids resolve under their key = member_count"
  else ck FAIL "R8.l newest vintage integrity" "vintage $vid: member_count $vmc, only $rj ids resolve under their key"; fi
else ck PASS "R8.l newest vintage integrity" "vintage $vid: runs add up to $vsum = member_count (full join runs at gates)"; fi

# R8.m  no connection-pool starvation: sessions idle in a transaction for over a minute
r=$(q -c "SELECT count(*) FILTER (WHERE state = 'idle in transaction' AND now() - state_change > interval '60 seconds') || '|' || count(*) FROM pg_stat_activity WHERE datname = current_database()")
IFS='|' read -r iit conns <<< "$r"
[ "$iit" = 0 ] && ck PASS "R8.m connections" "$conns open, 0 idle in a transaction over 60 s" || ck FAIL "R8.m connections" "$iit idle in a transaction over 60 s ($conns open)"

# R8.n  host disk
free=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
[ "$free" -ge 5 ] && ck PASS "R8.n host disk free" "${free} GB" || { [ "$free" -ge 3 ] && ck WARN "R8.n host disk free" "${free} GB" || ck FAIL "R8.n host disk free" "${free} GB"; }

# ---- standing invariants from v0.5.0 to v0.5.3 (new in the cumulative list) ----
# R8.p  schema_migrations is exactly the baseline (v0.5.4 applies no migration; 0.5.1 R2.6/R7.2)
q -c "SELECT name FROM schema_migrations ORDER BY name" > "$R8_STATE/migrations-now.txt"
if [ "${R8_RECORD:-0}" = 1 ]; then cp "$R8_STATE/migrations-now.txt" "$R8_STATE/migrations-base.txt"; fi
if [ ! -s "$R8_STATE/migrations-base.txt" ]; then ck FAIL "R8.p schema_migrations" "no baseline recorded (run once with R8_RECORD=1)"
elif diff -q "$R8_STATE/migrations-base.txt" "$R8_STATE/migrations-now.txt" >/dev/null; then ck PASS "R8.p schema_migrations" "$(wc -l < "$R8_STATE/migrations-now.txt") rows, identical to the baseline"
else ck FAIL "R8.p schema_migrations" "differs from the baseline: $(diff "$R8_STATE/migrations-base.txt" "$R8_STATE/migrations-now.txt" | grep -c '^[<>]') lines"; fi
# R8.q  judge config: enforce, the pinned model, third parties off (0.5.0 6.8/7.2, 0.5.1 R6.5)
r=$(q -c "SELECT mode || '|' || coalesce(model, 'NULL') || '|' || third_party_enabled FROM swarm_judge_config LIMIT 1")
[ "$r" = "enforce|opencode/deepseek-v4-flash|false" ] || [ "$r" = "enforce|deepseek-v4-flash|false" ] && ck PASS "R8.q judge config" "$r" || ck FAIL "R8.q judge config" "$r (expected enforce, the pinned model, third_party_enabled false)"
# R8.r  role and grant integrity (0.5.0 4.4, 0.5.1 R2.7/R2.8): rm_worker INSERTs, the api connects as rm_app, rm_readonly reads sequences
if [ "$PROJECT" != rm_prod ]; then ck INFO "R8.r grants" "not checked on a twin: the dump is taken with --no-privileges, so a twin holds no grants. Production is checked at R2.11 and R7.11"
else
r=$(q -c "SELECT bool_and(has_table_privilege('rm_worker', t, 'INSERT')) FROM unnest(array['wallet_backfill_state','chain_day_blocks','chain_address_floors']) t")
[ "$r" = true ] && ck PASS "R8.r rm_worker grants" "INSERT on the 3 chain-state tables" || ck FAIL "R8.r rm_worker grants" "rm_worker lacks INSERT on a chain-state table ($r)"
r=$(q -c "SELECT current_user")
[ "$r" = rm_app ] && ck PASS "R8.r api role" "rm_app (never doadmin)" || ck FAIL "R8.r api role" "$r"
r=$(q -c "SELECT bool_and(CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('rm_readonly', c.oid, 'SELECT') ELSE true END) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S'")
[ "$r" = true ] && ck PASS "R8.r rm_readonly sequences" "SELECT on every public sequence" || ck FAIL "R8.r rm_readonly sequences" "$r"
fi
# R8.s  api and public health (0.5.1 R7.5): /health and the judgements route answer 200
h=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/health"); h2=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/health")
sid=$(q -c "SELECT id FROM swarm_sessions WHERE state = 'published' ORDER BY published_at DESC LIMIT 1")
j=$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/swarm/sessions/$sid/judgements")
{ [ "$h" = 200 ] || [ "$h2" = 200 ]; } && [ "$j" = 200 ] && ck PASS "R8.s health and judgements" "/health $h, /api/health $h2, judgements $j" || ck FAIL "R8.s health and judgements" "/health $h, /api/health $h2, judgements $j"
# R8.t  every published session since T0 has openedAt, never null (v0.5.4)
r=$(curl -s "$BASE_URL/api/swarm/sessions?limit=50" | python3 -c "import json,sys; s=json.load(sys.stdin)['sessions']; print(sum(1 for x in s if x['state'] == 'published' and not x.get('openedAt') and x['date'] >= '2026-09-22'))" 2>/dev/null)
[ "$r" = 0 ] && ck PASS "R8.t openedAt" "0 of the 50 newest published sessions dated 2026-09-22 or later lack it (older sessions have no brief revision to read)" || ck FAIL "R8.t openedAt" "${r:-unreadable} sessions from 2026-09-22 on lack it"

# ---- v0.5.4 claims (issues 1057/1081/1084, 1058, 1060, 1061, 1062) ----
# R8.u  the api: no cut-off at the 10 s limit on a reader; every request over 5 s is listed (issue 1079 owns the known ones)
al=$(docker logs --since "$T0" "$C" 2>&1)
to=$(printf '%s\n' "$al" | grep -a -c 'timed out after')
sl=$(printf '%s\n' "$al" | grep -a -c '\[api\] slow request')
rp=$(printf '%s\n' "$al" | grep -a -c '\[api\] request ran past')
[ "$to" = 0 ] && ck PASS "R8.u api cut-offs" "0 'timed out after'" || ck FAIL "R8.u api cut-offs" "$to 'timed out after' line(s)"
if [ "$sl$rp" = 00 ]; then ck PASS "R8.u2 api slow requests" "0 over 5 s"; else ck WARN "R8.u2 api slow requests" "$sl slow (over 5 s), $rp ran past the limit; paths: $(printf '%s\n' "$al" | grep -a -E '\[api\] (slow request|request ran past)' | grep -a -oE '(GET|POST|PUT|PATCH|DELETE) /[^ ]+' | sort | uniq -c | sort -rn | head -4 | tr '\n' ';')"; fi
# R8.v  the buyback scan never fails on a refused range (1061)
bl=$(docker logs --since "$T0" "$PROJECT-worker-analytics-1" 2>&1 | grep -a -c 'live index failed')
b4=$(docker logs --since "$T0" "$PROJECT-worker-analytics-1" 2>&1 | grep -a -c 'HTTP 413')
[ "$bl" = 0 ] && ck PASS "R8.v buyback" "0 'live index failed' ($b4 HTTP 413 answers, each halved)" || ck FAIL "R8.v buyback" "$bl 'live index failed'"
# R8.w  Gecko: the tier matches the key (1062); no 429/401/403; the key is in no ledger row and no api/website environment
has_key=$(docker exec "$PROJECT-worker-analytics-1" sh -c 'test -n "$COINGECKO_API_KEY" && echo yes || echo no' 2>/dev/null)
gl=$( { docker logs --since "$T0" "$PROJECT-analytics-producer-1" 2>&1; docker logs --since "$T0" "$PROJECT-worker-analytics-1" 2>&1; } | grep -a '\[gecko\]')
tier_pro=$(printf '%s\n' "$gl" | grep -a -c 'pro tier'); tier_free=$(printf '%s\n' "$gl" | grep -a -c 'free tier')
if [ "$has_key" = yes ] && [ "$tier_pro$tier_free" = 00 ]; then ck INFO "R8.w gecko tier" "key set; no [gecko] line yet (the analytics worker or producer logs one when its sweep runs)"
elif [ "$has_key" = yes ]; then [ "$tier_pro" -ge 1 ] && [ "$tier_free" = 0 ] && ck PASS "R8.w gecko tier" "key set: $tier_pro line(s) via the pro tier, 0 via free" || ck FAIL "R8.w gecko tier" "key set but pro=$tier_pro free=$tier_free"
else [ "$tier_pro" = 0 ] && ck PASS "R8.w gecko tier" "no key: $tier_free line(s) via the free tier" || ck FAIL "R8.w gecko tier" "no key set but $tier_pro line(s) via pro"; fi
g4=$( { docker logs --since "$T0" "$PROJECT-analytics-producer-1" 2>&1; docker logs --since "$T0" "$PROJECT-worker-analytics-1" 2>&1; } | grep -a -c -E 'answered HTTP 40[13]|Gecko.*HTTP 429|\[gecko\].*429')
[ "$g4" = 0 ] && ck PASS "R8.w2 gecko errors" "0 lines of HTTP 429/401/403" || ck FAIL "R8.w2 gecko errors" "$g4 lines of HTTP 429/401/403"
kl=$(q -c "SELECT count(*) FROM source_fetches WHERE request_identity::text ~* 'x-cg-pro-api-key' AND request_identity::text !~ 'REDACTED'")
ke=$(for s in api website-server; do docker exec "$PROJECT-$s-1" sh -c 'env | grep -c COINGECKO' 2>/dev/null; done | paste -sd+ | bc)
[ "$kl" = 0 ] && [ "${ke:-0}" = 0 ] && ck PASS "R8.w3 key containment" "0 unredacted ledger rows; 0 COINGECKO variables in the api and the website" || ck FAIL "R8.w3 key containment" "ledger rows=$kl api+website vars=$ke"
# R8.x  the regime day (1058): the DRIVER logs `regime asof D` (no container does). Pass the driver log in DRIVER_LOG
# (each line there starts with the UTC time it was logged; a twin log is stamped by the runbook's tee, production's by R6.4's).
# Every `regime asof` line must name the UTC day it was written. The driver log carries no date, so compare to today's UTC date.
if [ -n "${DRIVER_LOG:-}" ] && [ -r "$DRIVER_LOG" ]; then
  today=$(date -u +%F)
  nr=$(grep -a -c 'regime asof' "$DRIVER_LOG")
  bd=$(grep -a 'regime asof' "$DRIVER_LOG" | grep -a -v "regime asof $today" | wc -l)
  if [ "$nr" = 0 ]; then ck INFO "R8.x regime day" "no regime line in the driver log yet"
  elif [ "$bd" = 0 ]; then ck PASS "R8.x regime day" "$nr regime line(s), all dated today ($today UTC)"
  else ck WARN "R8.x regime day" "$bd of $nr line(s) are not dated $today (expected only if the log spans midnight UTC; check by hand)"; fi
else ck INFO "R8.x regime day" "set DRIVER_LOG to the driver log to check it (R4.6 and R7.5 do this by hand)"; fi

# R8.o  informational: error-like lines per container since T0 (the gate classifies them; this is the raw count)
for c in $(docker ps --format '{{.Names}}' | grep "^$PROJECT-"); do
  e=$(docker logs --since "$T0" "$c" 2>&1 | grep -a -v RM_TELEMETRY | grep -a -c -iE 'error|fatal|refus|denied|timed out|exception|panic')
  printf '  [INFO] R8.o %s: %s error-like lines since T0\n' "${c#$PROJECT-}" "$e"
done
nq=$(wc -l < "$QERRFILE")
[ "$nq" = 0 ] || ck FAIL "R8.z queries that errored" "$nq (any PASS above that shows an empty or ERROR value is not a pass)"
echo "== soak checks result: $FAILS FAIL, $WARNS WARN"
[ "$FAILS" = 0 ]
