#!/usr/bin/env bash
#
# Boot a real Bedrock Dedicated Server with the probe pack installed, run the battery, and
# leave the log where `bedshock run` can read it.
#
# WHY A REAL SERVER. Bedrock rejects an entire behavior pack when it dislikes something -- a
# script module version it does not have, a malformed entity -- and it does so SILENTLY in a
# client. No error; the content simply is not there. The server, unlike the client, prints the
# reason. For a battery that is not a convenience, it is the difference between "this capability
# is absent" and "the pack never loaded", and recording the second as the first would poison
# the ledger with confident negatives.
#
# It is also what makes a version sweep possible at all. The same artifact, booted against
# server builds for several Minecraft versions, answers the automated half of the battery on
# each of them without anyone installing anything.
#
# Usage: tools/bds.sh <build-dir> <log-path> [bds-url]
#
# With no URL it resolves the CURRENT server from Microsoft's download-links API. Pass one
# explicitly to measure an older version -- which is the whole point of the version axis, and
# the only way to fill in a column for a Bedrock that is no longer current.
set -uo pipefail

BUILD_DIR="${1:?usage: bds.sh <build-dir> <log-path> [bds-url]}"
LOG_OUT="${2:?usage: bds.sh <build-dir> <log-path> [bds-url]}"
BDS_URL_IN="${3:-}"

WORK="${BEDSHOCK_WORK:-${RUNNER_TEMP:-/tmp}}/bedshock-bds"
LEVEL="battery"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-120}"
BATTERY_TIMEOUT="${BATTERY_TIMEOUT:-120}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*" >&2; }

if [ -n "$BDS_URL_IN" ]; then
  BDS_URL="$BDS_URL_IN"
  say "Using the server build you named"
else
  say "Resolving the current Bedrock Dedicated Server"
  LINKS_JSON="$(curl -fsSL -A "Mozilla/5.0" \
    "https://net-secondary.web.minecraft-services.net/api/v1.0/download/links" || true)"
  BDS_URL="$(printf '%s' "$LINKS_JSON" | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for entry in data.get('result', {}).get('links', []):
    if entry.get('downloadType') == 'serverBedrockLinux':
        print(entry.get('downloadUrl', ''))
        break
" 2>/dev/null || true)"
fi

if [ -z "$BDS_URL" ]; then
  echo "Could not resolve a Bedrock Dedicated Server download URL." >&2
  echo "Pass one explicitly as the third argument -- and note that measuring an OLD version" >&2
  echo "requires an old server build, which this API only ever offers the newest of." >&2
  exit 1
fi
echo "$BDS_URL" >&2

say "Downloading"
rm -rf "$WORK"; mkdir -p "$WORK"
curl -fsSL -A "Mozilla/5.0" -o "$WORK/bds.zip" "$BDS_URL" || { echo "Download failed." >&2; exit 1; }
unzip -q "$WORK/bds.zip" -d "$WORK/server"
chmod +x "$WORK/server/bedrock_server"

say "Installing the pack"
BP_UUID="$(python3 -c "import json;print(json.load(open('$BUILD_DIR/BP/manifest.json'))['header']['uuid'])")"
RP_UUID="$(python3 -c "import json;print(json.load(open('$BUILD_DIR/RP/manifest.json'))['header']['uuid'])")"
VERSION="$(python3 -c "import json;print(json.dumps(json.load(open('$BUILD_DIR/BP/manifest.json'))['header']['version']))")"

# The script pins, printed whether or not anything goes wrong. A whole-pack rejection over a
# module version is the single most likely way for a battery run to measure nothing, and it is
# invisible unless you can see what was asked for.
echo "behavior $BP_UUID  resource $RP_UUID  version $VERSION" >&2
python3 -c "
import json
for d in json.load(open('$BUILD_DIR/BP/manifest.json')).get('dependencies', []):
    if 'module_name' in d:
        print('  pin %s %s' % (d['module_name'], d['version']))
" >&2

WORLD="$WORK/server/worlds/$LEVEL"
mkdir -p "$WORLD"
cp -r "$BUILD_DIR/BP" "$WORK/server/behavior_packs/bedshock"
cp -r "$BUILD_DIR/RP" "$WORK/server/resource_packs/bedshock"
printf '[{"pack_id":"%s","version":%s}]' "$BP_UUID" "$VERSION" > "$WORLD/world_behavior_packs.json"
printf '[{"pack_id":"%s","version":%s}]' "$RP_UUID" "$VERSION" > "$WORLD/world_resource_packs.json"

cat > "$WORK/server/server.properties" <<PROPS
server-name=bedshock-battery
gamemode=creative
difficulty=peaceful
level-name=$LEVEL
level-type=FLAT
online-mode=false
allow-cheats=true
max-players=1
server-port=19132
content-log-file-enabled=true
PROPS

say "Booting"
LOG="$WORK/server.log"
cd "$WORK/server"

# A FIFO on stdin so the console can be driven: the battery is triggered by a script event, and
# `stop` shuts the server down cleanly afterwards.
CMD="$WORK/console.fifo"
rm -f "$CMD"; mkfifo "$CMD"
LD_LIBRARY_PATH=. ./bedrock_server < "$CMD" > "$LOG" 2>&1 &
BDS_PID=$!
exec 3> "$CMD"   # hold the write end open, or the server sees EOF and exits

started=0
for _ in $(seq 1 "$BOOT_TIMEOUT"); do
  if grep -q "Server started" "$LOG" 2>/dev/null; then started=1; break; fi
  if ! kill -0 "$BDS_PID" 2>/dev/null; then break; fi
  sleep 1
done

battery_ran=0
if [ "$started" -eq 1 ]; then
  # The script engine needs a moment to finish registering listeners, and the battery claims a
  # ticking area and waits for the chunk before asserting anything.
  sleep 3

  # BEDSHOCK_PROBES narrows the run to named probes. Empty means the whole battery.
  #
  # This is what makes a version sweep cheap: once a capability is settled, re-asking it is a
  # drift check rather than a question, and the rows still OPEN are the ones worth spending a
  # server boot on. `bedshock run --open` computes the list; this just sends it.
  if [ -n "${BEDSHOCK_PROBES:-}" ]; then
    IFS=',' read -r -a PROBE_LIST <<< "$BEDSHOCK_PROBES"
  else
    PROBE_LIST=("")
  fi

  wanted=${#PROBE_LIST[@]}
  say "Running the battery (${wanted} invocation(s))"

  for probe in "${PROBE_LIST[@]}"; do
    echo "scriptevent bedshock:probe $probe" >&3
    sleep 1
  done

  # Each invocation prints its own DONE, so waiting for that many is how a narrowed run knows
  # it finished rather than guessing from a timeout.
  for _ in $(seq 1 "$BATTERY_TIMEOUT"); do
    # `grep -c` prints its count AND exits 1 when the count is zero, so `|| echo 0` appends a
    # second line and the comparison below sees "0\n0" -- which bash reports as
    # "integer expression expected" and treats as false. Harmless while the battery finishes
    # anyway, and a hang the one time it does not.
    seen="$(grep -c "BEDSHOCK DONE" "$LOG" 2>/dev/null)" || seen=0
    [ -n "$seen" ] || seen=0
    if [ "$seen" -ge "$wanted" ]; then battery_ran=1; break; fi
    if ! kill -0 "$BDS_PID" 2>/dev/null; then break; fi
    sleep 1
  done
fi

echo "stop" >&3 || true
sleep 3
exec 3>&- || true
kill "$BDS_PID" 2>/dev/null || true
wait "$BDS_PID" 2>/dev/null || true

mkdir -p "$(dirname "$LOG_OUT")"
cp "$LOG" "$LOG_OUT"

if [ "$started" -ne 1 ]; then
  echo "FAIL: the server never reported 'Server started'." >&2
  exit 1
fi

# A run that never reported back measured NOTHING, and that is the one outcome which must never
# reach the ledger. An absent result is not a negative result: the likeliest cause is the whole
# behavior pack being rejected over a script pin, which says everything about the manifest and
# nothing about the game.
if [ "$battery_ran" -ne 1 ]; then
  echo "FAIL: the battery never reported back." >&2
  echo "      Either the script module did not load, or the event never reached it. Nothing is" >&2
  echo "      recorded -- an absent answer is not a negative one." >&2
  grep -Ei "ERROR|Failed to|cannot be loaded|Unsupported|unknown module|Script error" "$LOG" | head -20 >&2 || true
  exit 2
fi

say "Battery reported back"
exit 0
