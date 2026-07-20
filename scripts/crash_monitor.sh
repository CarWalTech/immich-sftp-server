#!/bin/bash
# Watches immich-file-bridge for a crash/restart while real traffic flows through it.
# - Samples memory continuously to mem_history.log (not stdout — avoid spam).
# - Probes the WebDAV port every cycle for liveness/latency.
# - Emits an event line (stdout, becomes a Monitor notification) only on:
#     restart count change, container status change, OOMKilled flip, or a failed/slow probe.
# - On any event, immediately snapshots docker logs + inspect state before they're gone.

SCRATCH="/omv/apps-compose/immich-file-bridge/repo/logs/crash-monitor"
MEMLOG="$SCRATCH/mem_history.log"
CONTAINER=immich-file-bridge

# Keep this monitor from becoming a storage problem on a long unattended run:
# cap mem_history.log by size (truncate to the newest slice) and cap the number
# of retained crash dumps (delete oldest beyond the count).
MEMLOG_MAX_BYTES=$((20 * 1024 * 1024))
MEMLOG_KEEP_LINES=100000
DUMP_KEEP_COUNT=50

rotate_memlog() {
  local size
  size=$(stat -c '%s' "$MEMLOG" 2>/dev/null) || return
  if [ "$size" -gt "$MEMLOG_MAX_BYTES" ]; then
    tail -n "$MEMLOG_KEEP_LINES" "$MEMLOG" > "$MEMLOG.tmp" && mv "$MEMLOG.tmp" "$MEMLOG"
  fi
}

prune_dumps() {
  ls -1t "$SCRATCH"/crash_dump_*.txt 2>/dev/null | tail -n +$((DUMP_KEEP_COUNT + 1)) | xargs -r rm -f
}

prev_restart=$(docker inspect "$CONTAINER" --format '{{.RestartCount}}' 2>/dev/null)
prev_status=$(docker inspect "$CONTAINER" --format '{{.State.Status}}' 2>/dev/null)
prev_started=$(docker inspect "$CONTAINER" --format '{{.State.StartedAt}}' 2>/dev/null)

echo "MONITOR STARTED: restartCount=$prev_restart status=$prev_status startedAt=$prev_started"

# The liveness probe is itself real traffic that touches the app (each request
# appears to leave a small amount of unreleased memory — a separate, minor finding).
# Sample memory every cycle (cheap, doesn't touch the app at all — reads cgroup
# stats via dockerd), but only probe every Nth cycle so the watcher doesn't become
# a meaningful load source and pollute idle-baseline readings.
PROBE_EVERY_N_CYCLES=6
cycle=0
probe_ok="yes"
probe_code="-"

while true; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  cycle=$((cycle + 1))

  mem=$(docker stats --no-stream --format '{{.MemUsage}} ({{.MemPerc}}) CPU={{.CPUPerc}}' "$CONTAINER" 2>/dev/null)
  conns=$(ss -tan state established "( dport = :19000 or sport = :19000 )" 2>/dev/null | tail -n +2 | wc -l)
  echo "$ts $mem conns=$conns" >> "$MEMLOG"
  rotate_memlog

  if [ $((cycle % PROBE_EVERY_N_CYCLES)) -eq 0 ]; then
    probe_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:19000/ 2>/dev/null)
    probe_ok="yes"
    if [ "$probe_code" != "401" ]; then probe_ok="no"; fi
  fi

  restart=$(docker inspect "$CONTAINER" --format '{{.RestartCount}}' 2>/dev/null)
  status=$(docker inspect "$CONTAINER" --format '{{.State.Status}}' 2>/dev/null)
  started=$(docker inspect "$CONTAINER" --format '{{.State.StartedAt}}' 2>/dev/null)
  oom=$(docker inspect "$CONTAINER" --format '{{.State.OOMKilled}}' 2>/dev/null)
  exitcode=$(docker inspect "$CONTAINER" --format '{{.State.ExitCode}}' 2>/dev/null)

  event=""
  if [ "$restart" != "$prev_restart" ]; then event="RESTART_COUNT $prev_restart -> $restart"; fi
  if [ "$started" != "$prev_started" ]; then event="$event RESTARTED_AT $started"; fi
  if [ "$status" != "$prev_status" ]; then event="$event STATUS $prev_status -> $status"; fi
  if [ "$oom" == "true" ]; then event="$event OOM_KILLED"; fi
  if [ "$probe_ok" == "no" ]; then event="$event PROBE_FAILED(http=$probe_code)"; fi

  if [ -n "$event" ]; then
    dumpfile="$SCRATCH/crash_dump_$ts.txt"
    {
      echo "=== EVENT at $ts: $event ==="
      echo "--- last known good memory ---"
      tail -5 "$MEMLOG"
      echo "--- docker inspect state ---"
      docker inspect "$CONTAINER" --format '{{json .State}}' 2>&1
      echo "--- last 300 log lines ---"
      docker logs "$CONTAINER" --tail 300 -t 2>&1
    } > "$dumpfile"
    echo "EVENT $ts: $event | mem=$mem | exitCode=$exitcode | dump=$dumpfile"
    prune_dumps
  fi

  prev_restart="$restart"
  prev_status="$status"
  prev_started="$started"

  sleep 5
done
