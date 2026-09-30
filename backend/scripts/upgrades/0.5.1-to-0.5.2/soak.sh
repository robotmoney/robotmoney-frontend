# R8 unattended soak for v0.5.2. T0 = 2026-09-29T22:26:38Z.
#  * GATES at T0 +6/+12/+18/+24 h: prod:gate (+ the 24 h run grades sessions and liveness) and the release-claim checks.
#  * PULSES 20 minutes after every 3-hourly regime slot (00:50, 03:50, ...): the release-claim checks only, so a failed
#    regime or research run is seen within the hour and not at the next gate.
export PATH=/root/.bun/bin:$PATH
cd /root/robotmoney-frontend
T0=2026-09-29T22:26:38Z
t0=$(date -d $T0 +%s)
events=""
for h in 6 12 18 24; do events="$events $(( t0 + h*3600 )):gate:$h"; done
for k in $(seq 0 8); do
  p=$(date -u -d "2026-09-30 00:50:00 UTC +$(( k*3 )) hours" +%s)
  [ "$p" -gt "$t0" ] && [ "$p" -le $(( t0 + 24*3600 + 3600 )) ] && events="$events $p:pulse:$k"
done
for ev in $(echo $events | tr ' ' '\n' | sort -n); do
  target=${ev%%:*}; rest=${ev#*:}; kind=${rest%%:*}; n=${rest#*:}
  now=$(date +%s); [ $target -gt $now ] && sleep $(( target - now ))
  if [ "$kind" = gate ]; then
    h=$n; extra="--defer-sessions"; [ $h = 24 ] && extra="--liveness-hours 12"
    echo "== R8 gate +${h}h $(date -u +%FT%TZ)" >> /root/r8-soak-v052.log
    bun run prod:gate -- --mode post-release --release v0.5.2 --since $T0 $extra --db-capacity-gb 30 \
      --state-file /root/robotmoney-frontend/.agents/smoke-state.json --driver-log /root/smoke-archive-v0.5.2.log \
      --report /root/prod-gate-reports/R8-${h}h-becb6897.md 2>&1 | grep -E "PASS|FAIL|WARN|report:" | grep -v "Log scan" | cut -c1-320 | tail -14 >> /root/r8-soak-v052.log
    echo "gate exit=${PIPESTATUS[0]}" >> /root/r8-soak-v052.log
  else
    echo "== R8 pulse $(date -u +%FT%TZ)" >> /root/r8-soak-v052.log
  fi
  full=0; [ "$kind" = gate ] && full=1
  R8_FULL=$full bash /root/r8-checks-v052.sh $T0 2>&1 | cut -c1-320 >> /root/r8-soak-v052.log
done
echo "== R8 done $(date -u +%FT%TZ)" >> /root/r8-soak-v052.log
