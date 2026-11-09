#!/usr/bin/env bash
# Every scripted check on an exported video, in parallel, against the user's limits. No flag loosens them.
#
#   check.sh VIDEO.mp4 [--profile narrated|captions] [--timeline T.json] [--voice VOICE.wav] [--area W:H:X:Y]
#            [--caption-box X,Y,W,H] [--since EARLIER.mp4 [--allow T0-T1]...] [--out DIR]
#   check.sh --setup [web] [android] [ios] [compose]
#   check.sh --self-test
#
# --setup checks this machine before a video: the tools every video needs, the tools each named picture kind needs,
# the speech model and a voice key. It prints "setup: ready" and exits 0, or names what is missing and what to do,
# and exits 1.
# Profiles: narrated (the default) runs every check, and fails a video with no audio stream. captions, for a
# captions-only clip with no voice, reports dead air, quiet gaps and loudness as not applicable, because its
# holds are frozen and silent by design. The profile and --voice pass on to sync.py.
# --timeline is a recorded cut's timeline.json or a composed film's voice.json: its lines are the narration.
# A recorded cut (a timeline with shots) also runs sync.py, framing.py and overlays.py on VIDEO; a composed film
# runs sync.py when --caption-box names its burned caption band.
# Writes to DIR (default checks/ beside VIDEO) verdict.txt, whose first line is "sha256 HASH VIDEO", then one line per check
# with its status and, when it ran, its detail file in DIR. checks.txt holds:
# - dead air: a span over 1.0 s where the picture is frozen (freezedetect -50 dB) and the sound silent
#   (silencedetect -35 dB) at once;
# - quiet gaps, when a timeline names the narration lines: a quiet span (-35 dB, >= 0.1 s) between lines over
#   0.5 s, or inside one line over 0.6 s. A music bed fills the pauses, so they are measured on the voice:
#   --voice, or the timeline's voice track, once its loudness over time matches the export's audio at zero lag
#   (correlation at least 0.7). A voice that does not match fails;
# - loudness: EBU R128 integrated outside -16 +-1 LUFS, true peak above -1.0 dBTP, or either not measured;
# - dark dips, for a composed film only (--area given, or a timeline with no take shots): a frame whose mean
#   brightness over the picture area (--area, ffmpeg crop syntax, default the whole frame) is more than 25%
#   below the brightest frame both in the 1 s before it and in the 1 s after it. A fade through black dips, and
#   so do an outgoing fade and a late incoming fade that leave the background showing between them. A
#   cross-dissolve does not. A recorded cut is not applicable: a real dialog backdrop dims the page.
# --since proves a re-cut changed only what it meant to, for the re-watch. It is PASS when its decoded audio and its
# subtitle track match EARLIER's and framediff.py finds no changed frame outside the --allow spans (seconds),
# LOOK otherwise, which means the watchers watch the whole export.
# The privacy pass reads one frame a second into ocr.txt, picked by index, upscaled 2x to grey, read by tesseract
# --psm 11. Each distinct line with @, mail or .com is a hit, with its first and last time and first frame.
# Hits are LOOK, not FAIL, so compare each by eye with the identities allowed on screen.
# Exit 1 when an applicable check fails, 0 otherwise.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

need() {
  case "$1" in
    video) echo "bash ffmpeg ffprobe uv python3 jq tesseract sha256sum" ;;
    web) echo "Xvfb xdotool xdpyinfo agent-browser node ${CHROMIUM:-chromium}" ;;
    android) echo "adb emulator avdmanager maestro java" ;;
    ios) echo "xcrun maestro java" ;;
    compose) echo "node npx bun" ;;
    *) return 1 ;;
  esac
}

has() {
  local v
  [ "$1" = bash ] || command -v "$1" > /dev/null || return 1
  case "$1" in
    bash) [ "${BASH_VERSINFO[0]}" -ge 4 ] ;;
    node) v="$(node -v)"; v="${v#v}"; [ "${v%%.*}" -ge 22 ] 2> /dev/null ;;
    java) [[ "$(java -version 2>&1)" =~ \"([0-9]+) ]] && [ "${BASH_REMATCH[1]}" -ge 17 ] ;;
    ffmpeg) [[ "$(ffmpeg -hide_banner -encoders)" == *libx264* ]] ;;
    xcrun) xcrun simctl help > /dev/null 2>&1 ;;
  esac
}

setup() {
  local k t m hub tools miss=() rc=0 doc="${HERE%/scripts}/references/setup.md"
  for k in video "$@"; do
    tools="$(need "$k")" || { echo "check.sh: --setup takes web, android, ios or compose, not $k" >&2; return 2; }
    for t in $tools; do has "$t" || miss+=("$t ($k)"); done
  done
  m="${WHISPER_MODEL:-small.en}" hub="${HF_HUB_CACHE:-${HUGGINGFACE_HUB_CACHE:-${HF_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/huggingface}/hub}}"
  [[ "$m" == */* || "$m" == *distil* || "$m" == *turbo ]] ||
    compgen -G "$hub/models--Systran--faster-whisper-$m/snapshots/*/model.bin" > /dev/null || miss+=("faster-whisper $m (video)")
  [ ${#miss[@]} = 0 ] || { echo "Missing or too old: ${miss[*]}. Install each per $doc, then run check.sh --setup again."; rc=1; }
  [ -n "${GEMINI_API_KEY:-}${ELEVENLABS_API_KEY:-}" ] || { rc=1; echo "No voice key: GEMINI_API_KEY and" \
    "ELEVENLABS_API_KEY are both unset. Stop and ask the user one question: go on without a voice (captions only)," \
    "set up a Gemini key, or set up an ElevenLabs key. $doc says how to get and set each."; }
  [ "$rc" = 1 ] || echo "setup: ready"
  return "$rc"
}

self_test() {
  local d rc=0
  d="$(mktemp -d)"
  trap 'rm -rf "$d"' RETURN
  expect() {
    local want="$1" msg="$2" got=0
    shift 2
    "$d/bin/check.sh" "$@" > "$d/last.txt" 2>&1 || got=$?
    [ "$got" = "$want" ] || { echo "  $msg: exit $got, want $want"; rc=1; }
  }
  says() { grep -qE "$1" "$d/last.txt" || { echo "  $2: no line matches '$1'"; rc=1; }; }
  mkdir "$d/bin" && cp "$0" "$d/bin/check.sh" && ln -s "$HERE/framediff.py" "$HERE/_media.py" "$d/bin/"
  for s in sync framing overlays; do printf '#!/bin/sh\necho "%s.py $*" >> "%s/calls"\n' "$s" "$d" > "$d/bin/$s.py"; done
  echo 'case "$1" in *misframed*) exit 1; esac' >> "$d/bin/framing.py"
  chmod +x "$d"/bin/{sync,framing,overlays}.py
  local enc=(-c:v libx264 -pix_fmt yuv420p) lossless=(-qp 0) src=(-f lavfi -i testsrc2=s=320x200:r=30:d=4)
  tone() { ffmpeg -v error -f lavfi -i "sine=f=330:d=4,volume='$1':eval=frame" -ar 48000 "$d/$2"; }
  tone 1.95 tone.wav                                    # -16 LUFS
  tone "if(between(t,1.5,2.5),0,1.95)" gap.wav          # a 1 s pause at 1.5 s
  tone "if(between(t,1,3),0,1.95)" hole.wav             # a 2 s silence at 1 s
  tone "if(between(t,2,2.05),7.5,1.95)" spike.wav       # -16 LUFS with a peak near 0 dBTP
  tone 3.1 loud.wav                                     # -12 LUFS
  tone 1.23 quiet.wav                                   # -20 LUFS
  for a in tone gap spike loud quiet; do ffmpeg -v error "${src[@]}" -i "$d/$a.wav" -shortest "${enc[@]}" "$d/$a.mp4"; done
  ffmpeg -v error "${src[@]}" "${enc[@]}" "$d/mute.mp4"
  ffmpeg -v error -f lavfi -i color=c=gray:s=320x200:r=30:d=4 -i "$d/hole.wav" -shortest "${enc[@]}" "$d/dead.mp4"
  ffmpeg -v error "${src[@]}" -i "$d/gap.wav" -f lavfi -i "sine=f=110:d=4,volume=0.3" -filter_complex amix=inputs=2:normalize=0 \
    -shortest "${enc[@]}" "$d/bed.mp4"
  ffmpeg -v error "${src[@]}" -f lavfi -i "sine=f=110:d=4,volume=1.5" -shortest "${enc[@]}" "$d/bedonly.mp4"
  ffmpeg -v error -f lavfi -i color=c=0xd0d0d0:s=320x200:r=30:d=3 -f lavfi -i color=c=0x404040:s=320x200:r=30:d=3 \
    -filter_complex "[0][1]xfade=transition=fade:duration=0.6:offset=2.2" "${enc[@]}" "$d/dissolve.mp4"
  ffmpeg -v error -f lavfi -i color=c=0xd0d0d0:s=320x200:r=30:d=3 -f lavfi -i color=c=0xa0a0a0:s=320x200:r=30:d=3 \
    -filter_complex "[0][1]xfade=transition=fadeblack:duration=0.6:offset=2.2" "${enc[@]}" "$d/fadeblack.mp4"
  for k in 0.7 0.8; do
    ffmpeg -v error -f lavfi -i color=c=0xc8c8c8:s=320x200:r=30:d=3 -vf "lutyuv=y='val*$k':enable='between(t,1.4,1.6)'" \
      "${enc[@]}" "$d/dip$k.mp4"
  done
  printf '{"lines":[{"text":"a","start":0.1,"end":1.5},{"text":"b","start":2.5,"end":3.9}]}' > "$d/two.json"
  printf '{"lines":[{"text":"a","start":0.1,"end":3.9}]}' > "$d/one.json"
  printf '{"lines":[{"text":"a","start":0.1,"end":1.5},{"text":"b","start":2.5,"end":3.9}],"voice":"%s"}' "$d/gap.wav" > "$d/voiced.json"
  printf '{"lines":[{"text":"a","start":0.1,"end":1.5},{"text":"b","start":2.5,"end":3.9}],"voice":"gemini:Iapetus"}' > "$d/named.json"
  printf '{"shots":[{"take":"t.mp4"}],"lines":[]}' | tee "$d/recorded.json" > "$d/misframed.json"
  ffmpeg -v error -i "$d/tone.mp4" -vf "drawtext=fontfile=$HERE/../fonts/Inter-Regular.ttf:text=cal@example.com:fontsize=28:fontcolor=black:box=1:boxcolor=white:x=20:y=80:enable='between(t,1.9,2.5)'" \
    "${enc[@]}" "${lossless[@]}" -c:a copy "$d/email.mp4"
  expect 0 "moving picture with steady sound failed" "$d/tone.mp4" --out "$d/c"
  says "^sha256 $(sha256sum "$d/tone.mp4" | cut -d' ' -f1) " "verdict.txt's first line is not the export's sha256"
  says "^PASS checks: checks.txt" "the passing export's own checks"
  says "^n/a  framing" "framing.py ran with no recorded cut"
  says "^PASS privacy OCR" "OCR read @, mail or .com in a test pattern"
  expect 0 "an email on screen failed the export" "$d/email.mp4" --out "$d/c"
  says "^LOOK privacy OCR: hits 1," "the email on screen at 2 s"
  grep -q "^2.00-2.00 s, frame 60: .*cal@example" "$d/c/ocr.txt" || { echo "  ocr.txt does not give the email's time and text"; rc=1; }
  expect 0 "a re-cut that adds an email outside its span failed" "$d/email.mp4" --since "$d/tone.mp4" --allow 3-4 --out "$d/c"
  says "^LOOK re-watch" "an email added outside the --allow span"
  expect 0 "a re-cut that changes only its span failed" "$d/email.mp4" --since "$d/tone.mp4" --allow 1.8-2.6 --out "$d/c"
  says "^PASS re-watch: same audio and subtitles as $(sha256sum "$d/tone.mp4" | cut -c1-64)" "a re-cut inside its span"
  expect 0 "a re-cut with a new voice failed" "$d/tone.mp4" --since "$d/quiet.mp4" --out "$d/c"
  says "^LOOK re-watch: the audio differs" "a re-cut with a new voice"
  expect 1 "2 s of frozen, silent video passed" "$d/dead.mp4" --out "$d/c"
  says "dead air .*: FAIL, 1" "the frozen, silent span"
  says "loudness: PASS" "the dead-air clip failed loudness too"
  expect 1 "a 1.0 s pause between lines passed" "$d/gap.mp4" --timeline "$d/two.json" --out "$d/c"
  says "between lines: 1; .* over 0.5 s: 1" "the pause between lines"
  says "loudness: PASS" "the gap clip failed loudness too"
  expect 1 "a 1.0 s pause inside a line passed" "$d/gap.mp4" --timeline "$d/one.json" --out "$d/c"
  says "inside a line: 1; .* over 0.6 s: 1" "the pause inside a line"
  expect 0 "a music bed fills the pause, measured on the export" "$d/bed.mp4" --timeline "$d/two.json" --out "$d/c"
  expect 1 "a pause under a music bed passed with the timeline's voice track" "$d/bed.mp4" --timeline "$d/voiced.json" --out "$d/c"
  says "on the voice .*FAIL" "the pause measured on the voice"
  expect 1 "a voice the export does not carry passed" "$d/bedonly.mp4" --timeline "$d/two.json" --voice "$d/gap.wav" --out "$d/c"
  says "is not the voice in this export" "the voice that does not match"
  expect 1 "a narrated video at -20 LUFS passed" "$d/quiet.mp4" --out "$d/c"
  says "loudness: FAIL, -2" "-20 LUFS"
  expect 1 "a narrated video at -12 LUFS passed" "$d/loud.mp4" --out "$d/c"
  says "loudness: FAIL, -1[123]\." "-12 LUFS"
  expect 1 "a true peak above -1 dBTP passed" "$d/spike.mp4" --out "$d/c"
  says "loudness: FAIL, -1[567]\.[0-9] LUFS.*true peak -0\." "a peak near 0 dBTP at -16 LUFS"
  expect 1 "a narrated video with no audio passed" "$d/mute.mp4" --out "$d/c"
  says "needs an audio stream" "the video with no audio"
  expect 0 "captions-only: a video with no audio failed" "$d/mute.mp4" --profile captions --out "$d/c"
  expect 0 "captions-only: a frozen, silent hold failed" "$d/dead.mp4" --profile captions --out "$d/c"
  expect 1 "a fade through black passed" "$d/fadeblack.mp4" --profile captions --area iw:ih:0:0 --out "$d/c"
  expect 0 "a bright-to-dark cross-dissolve failed" "$d/dissolve.mp4" --profile captions --area iw:ih:0:0 --out "$d/c"
  expect 1 "a 30% dip passed" "$d/dip0.7.mp4" --profile captions --area iw:ih:0:0 --out "$d/c"
  expect 0 "a 20% dip failed" "$d/dip0.8.mp4" --profile captions --area iw:ih:0:0 --out "$d/c"
  expect 0 "a recorded cut's fade failed the dip check" "$d/fadeblack.mp4" --profile captions --timeline "$d/recorded.json" --out "$d/c"
  says "dark dips: not applicable" "a recorded cut's dips"
  says "^PASS overlays: overlays.log" "a recorded cut's overlays"
  grep -q "^sync.py $d/recorded.json --video $d/fadeblack.mp4 --profile captions --out" "$d/calls" ||
    { echo "  sync.py did not get the timeline, export and profile: $(cat "$d/calls")"; rc=1; }
  expect 1 "a recorded cut whose framing fails passed" "$d/fadeblack.mp4" --profile captions --timeline "$d/misframed.json" --out "$d/c"
  says "^FAIL framing: framing.log" "the framing failure"
  expect 0 "a composed film with a caption band failed" "$d/tone.mp4" --timeline "$d/two.json" --caption-box 0,0,320,40 --out "$d/c"
  says "^n/a  overlays" "overlays.py ran on a composed film"
  expect 0 "a composed film whose voice.json names its voice failed" "$d/tone.mp4" --timeline "$d/named.json" --out "$d/c"
  grep -q "^sync.py $d/two.json --video $d/tone.mp4 --profile narrated --caption-box 0,0,320,40 --out" "$d/calls" ||
    { echo "  sync.py did not get the composed film's caption band: $(cat "$d/calls")"; rc=1; }
  mkdir "$d/path" && ln -s "$(command -v bash)" "$(command -v dirname)" "$d/path/"
  for t in ffprobe uv python3 jq tesseract sha256sum npx bun; do printf '#!/bin/sh\n' > "$d/path/$t" && chmod +x "$d/path/$t"; done
  printf '#!/bin/sh\necho libx264\n' > "$d/path/ffmpeg" && printf '#!/bin/sh\necho v22.0.0\n' > "$d/path/node"
  chmod +x "$d/path/ffmpeg" "$d/path/node"
  export WHISPER_MODEL=small.en HF_HUB_CACHE="$d/hub" && mkdir -p "$d/hub/models--Systran--faster-whisper-small.en/snapshots/x"
  : > "$d/hub/models--Systran--faster-whisper-small.en/snapshots/x/model.bin"
  PATH="$d/path" ELEVENLABS_API_KEY=sk-setup-selftest GEMINI_API_KEY='' expect 0 "setup with every tool and one key failed" --setup compose
  says "^setup: ready$" "the ready machine"
  PATH="$d/path" GEMINI_API_KEY='' ELEVENLABS_API_KEY='' expect 1 "setup with no voice key passed" --setup
  says "^No voice key: .*Stop and ask the user" "the missing voice key"
  printf '#!/bin/sh\necho v20.1.0\n' > "$d/path/node"
  PATH="$d/path" GEMINI_API_KEY=sk-setup-selftest expect 1 "setup for a composed film on Node 20 passed" --setup compose
  says "^Missing or too old: node \(compose\)\." "Node 20 for a composed film"
  ! grep -q sk-setup-selftest "$d/last.txt" || { echo "  setup printed a key"; rc=1; }
  printf '#!/bin/sh\n' > "$d/path/ffmpeg" && rm "$d/hub/models--Systran--faster-whisper-small.en/snapshots/x/model.bin"
  PATH="$d/path" GEMINI_API_KEY=sk-setup-selftest expect 1 "setup with no libx264 and no speech model passed" --setup
  says "^Missing or too old: ffmpeg \(video\) faster-whisper small.en \(video\)\. Install each per .*/references/setup.md" "the ffmpeg with no libx264 and the speech model not downloaded"
  expect 2 "setup took an unknown picture kind" --setup desktop
  expect 2 "setup took an empty picture kind" --setup ""
  [ "$rc" = 0 ] && echo "check.sh self-test: PASS" || echo "check.sh self-test: FAIL"
  return "$rc"
}

case "${1:-}" in
  ""|-h|--help) sed '1d;/^[^#]/,$d;s/^# \{0,1\}//' "$0"; exit 0 ;;
  --setup) shift; setup "$@"; exit $? ;;
  --self-test) self_test; exit $? ;;
esac

V="$(realpath "$1")"; shift
T="" VOICE="" OUT="" PROFILE=narrated AREA="" BOX="" SINCE="" ALLOW=()
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --timeline) T="$(realpath "$2")"; shift 2 ;;
    --voice) VOICE="$(realpath "$2")"; shift 2 ;;
    --area) AREA="$2"; shift 2 ;;
    --caption-box) BOX="$2"; shift 2 ;;
    --since) SINCE="$(realpath "$2")"; shift 2 ;;
    --allow) ALLOW+=(--allow "$2"); shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "check.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$PROFILE" in narrated|captions) ;; *) echo "check.sh: --profile is narrated or captions, not $PROFILE" >&2; exit 2 ;; esac
[ -n "$VOICE" ] || [ -z "$T" ] || { x="$(jq -r '.voice // empty' "$T")"; [ ! -f "$x" ] || VOICE="$x"; }  # a voice.json names a voice, not a file
C="${OUT:-$(dirname "$V")/checks}"
mkdir -p "$C"
rm -f "$C"/silencedetect*.log "$C"/ebur128.log "$C"/verdict.txt "$C"/{sync,framing,overlays,rewatch}.{md,json,log} "$C"/{ocr,checks}.txt
SHA="$(sha256sum "$V" | cut -d' ' -f1)"
declare -A JOB
start() { local n="$1"; shift; "$@" > "$C/$n.log" 2>&1 & JOB[$n]=$!; }
ocr() {
  local fps step d="$C/ocr"
  fps="$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$V")"
  step="$(awk -F/ '{print int($1 / $2 + 0.5)}' <<< "$fps")"
  rm -rf "$d" && mkdir "$d"
  ffmpeg -v error -i "$V" -map 0:v:0 -fps_mode passthrough -vf "select='not(mod(n,$step))',scale=2*iw:2*ih,format=gray" \
    -start_number 0 "$d/%06d.png"
  find "$d" -name '*.png' | OMP_THREAD_LIMIT=1 xargs -P 4 -I{} tesseract {} {} --psm 11
  awk -v step="$step" -v fps="$fps" 'BEGIN { split(fps, q, "/") }
    tolower($0) ~ /@|mail|\.com/ { n = FILENAME; sub(/.*\//, "", n); n = int(n) * step
      sub(/^ +/, ""); sub(/ +$/, ""); if (!($0 in first)) first[$0] = n; last[$0] = n }
    END { for (k in first) printf "%.2f-%.2f s, frame %d: %s\n", first[k] * q[2] / q[1], last[k] * q[2] / q[1], first[k], k }' \
    "$d"/*.txt | sort -n > "$C/ocr.txt"
  rm -rf "$d"
}
same() { [ "$(ffmpeg -v error -i "$SINCE" -map "0:$1?" -f "$2" - 2> /dev/null | sha256sum)" = \
           "$(ffmpeg -v error -i "$V" -map "0:$1?" -f "$2" - 2> /dev/null | sha256sum)" ]; }
rewatch() {
  same a s16le || { echo "the audio differs"; return 1; }
  same s srt || { echo "the subtitles differ"; return 1; }
  "$HERE/framediff.py" "$SINCE" "$V" "${ALLOW[@]}"
}
[ -z "$SINCE" ] || start rewatch rewatch
SHOTS=0
[ -n "$T" ] && jq -e '.shots | length > 0' "$T" > /dev/null && SHOTS=1
if [ "$SHOTS" = 1 ] || { [ -n "$T" ] && [ -n "$BOX" ]; }; then
  start sync "$HERE/sync.py" "$T" --video "$V" --profile "$PROFILE" ${VOICE:+--voice "$VOICE"} \
    ${BOX:+--caption-box "$BOX"} --out "$C"
fi
[ "$SHOTS" = 0 ] || { start framing "$HERE/framing.py" "$T" --video "$V" --out "$C"; start overlays "$HERE/overlays.py" "$T" --video "$V" --out "$C"; }
start ocr ocr
ffprobe -v error -show_entries format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels -of json "$V" > "$C/ffprobe.json"
ffmpeg -hide_banner -nostats -i "$V" -map 0:v -fps_mode passthrough -f null \
  -vf "freezedetect=n=-50dB:d=1.0,crop=${AREA:-iw:ih:0:0},signalstats,metadata=print:key=lavfi.signalstats.YAVG" - 2> "$C/picture.log"
MATCH=""
if grep -q '"codec_type": "audio"' "$C/ffprobe.json"; then
  ffmpeg -hide_banner -nostats -i "$V" -af "silencedetect=noise=-35dB:d=1.0" -map 0:a -f null - 2> "$C/silencedetect.log"
  ffmpeg -hide_banner -nostats -i "${VOICE:-$V}" -af "silencedetect=noise=-35dB:d=0.1" -map 0:a -f null - 2> "$C/silencedetect-0.1s.log"
  ffmpeg -hide_banner -nostats -i "$V" -af "ebur128=peak=true" -map 0:a -f null - 2> "$C/ebur128.log" || true
  [ -z "$VOICE" ] || MATCH="$(uv run --quiet --no-project --with numpy --with pillow python3 -c \
    'import sys; sys.path.insert(0, sys.argv[1]); import _media; print(_media.voice_match(sys.argv[2], sys.argv[3]))' "$HERE" "$V" "$VOICE")"
fi

set +e
python3 - "$C" "$PROFILE" "$T" "$VOICE" "$MATCH" "$AREA" <<'EOF'
import json, os, re, sys
c, profile, tpath, voice, match, area = sys.argv[1:7]
DEAD, BETWEEN, INLINE, DIP, DIPWIN, MATCH = 1.0, 0.5, 0.6, 0.25, 1.0, 0.7
tl = json.load(open(tpath)) if tpath else {}
probe = json.load(open(f"{c}/ffprobe.json"))
dur = float(probe["format"]["duration"])
num, den = next(s for s in probe["streams"] if s["codec_type"] == "video")["r_frame_rate"].split("/")
fps = int(num) / int(den)
def spans(path, a, b):
    txt = open(path).read()
    s = [float(x) for x in re.findall(a + r":\s*([\d.]+)", txt)]
    e = [float(x) for x in re.findall(b + r":\s*([\d.]+)", txt)]
    return list(zip(s, e + [dur] * (len(s) - len(e))))
out, bad = [f"duration {dur:.2f} s, profile {profile}"], False
fr = spans(f"{c}/picture.log", "lavfi.freezedetect.freeze_start", "lavfi.freezedetect.freeze_end")
if profile == "captions":
    out += [f"{k}: not applicable (captions-only profile)" for k in ("dead air", "quiet gaps", "loudness")]
elif not os.path.exists(f"{c}/silencedetect.log"):
    out.append("audio: FAIL, a narrated video needs an audio stream and this one has none; "
               "dead air, quiet gaps and loudness not measured")
    bad = True
else:
    si = spans(f"{c}/silencedetect.log", "silence_start", "silence_end")
    over = [(round(max(a0, b0), 2), round(min(a1, b1), 2)) for a0, a1 in fr for b0, b1 in si if min(a1, b1) - max(a0, b0) > DEAD]
    log = open(f"{c}/ebur128.log").read()
    lufs, lra, tp = (re.findall(p, log) for p in (r"I:\s*(-?[\d.]+) LUFS", r"LRA:\s*(-?[\d.]+) LU", r"Peak:\s*(-?[\d.]+) dBFS"))
    loud_bad = not (lufs and tp) or abs(float(lufs[-1]) + 16) > 1 or float(tp[-1]) > -1.0
    out += [f"dead air (frozen and silent at once, over {DEAD} s): {'FAIL' if over else 'PASS'}, {len(over)}",
            *[f"  {a:.2f}-{b:.2f} ({b - a:.2f} s)" for a, b in over],
            f"loudness: {'FAIL' if loud_bad else 'PASS'}, {lufs[-1] if lufs else 'not measured'} LUFS integrated (-16 +-1), "
            f"LRA {lra[-1] if lra else 'not measured'} LU, true peak {tp[-1] if tp else 'not measured'} dBTP (at most -1.0)"]
    bad = bool(over) or loud_bad
    if not tpath:
        out.append("quiet gaps: not measured, no --timeline names the narration lines")
    elif voice and float(match) < MATCH:
        out.append(f"quiet gaps: FAIL, {voice} is not the voice in this export: their loudness over time correlates "
                   f"{float(match):.2f} at zero lag, under {MATCH}")
        bad = True
    else:
        lines = tl.get("lines", [])
        q = spans(f"{c}/silencedetect-0.1s.log", "silence_start", "silence_end")
        btw, inl, edge = [], [], []
        for a, b in q:
            if not lines or b <= lines[0]["start"] + 0.05 or b >= dur - 0.05 or a >= lines[-1]["end"] - 0.05:
                edge.append((a, b))
                continue
            host = next((ln for ln in lines if ln["start"] + 0.05 <= a and b <= ln["end"] - 0.05), None)
            (inl if host else btw).append((a, b))
        wb = max((b - a for a, b in btw), default=0.0)
        wi = max((b - a for a, b in inl), default=0.0)
        where = f"the voice {voice} (loudness correlation {float(match):.2f} with the export)" if voice else "the export"
        out += [f"quiet gaps (-35 dB, >= 0.1 s) on {where}, against {len(lines)} narration lines: "
                f"{'FAIL' if wb > BETWEEN or wi > INLINE else 'PASS'}",
                f"  between lines: {len(btw)}; max {wb:.3f} s; over {BETWEEN} s: {sum(1 for a, b in btw if b - a > BETWEEN)}",
                *[f"    {a:.3f}-{b:.3f} ({b - a:.3f} s)" for a, b in btw if b - a > BETWEEN],
                f"  inside a line: {len(inl)}; max {wi:.3f} s; over {INLINE} s: {sum(1 for a, b in inl if b - a > INLINE)}",
                *[f"    {a:.3f}-{b:.3f} ({b - a:.3f} s)" for a, b in inl if b - a > INLINE],
                f"  lead-in and tail: {len(edge)}", *[f"    {a:.3f}-{b:.3f}" for a, b in edge]]
        bad = bad or wb > BETWEEN or wi > INLINE
if not (area or tpath):
    out.append("dark dips: not measured, no --area or --timeline says this is a composed film")
elif not area and tl.get("shots"):
    out.append("dark dips: not applicable, a recorded cut's dims are the app's own (a dialog backdrop)")
else:
    y = [float(v) for v in re.findall(r"YAVG=([\d.]+)", open(f"{c}/picture.log").read())]
    w = max(1, round(DIPWIN * fps))
    before = lambda i: max(y[max(0, i - w):i], default=0.0)
    after = lambda i: max(y[i + 1:i + 1 + w], default=0.0)
    depth = [(1 - v / r if r - v > 3 else 0.0) for v, r in ((v, min(before(i), after(i))) for i, v in enumerate(y))]
    runs = []
    for i, d in enumerate(depth):
        if d > DIP:
            if runs and runs[-1][1] == i - 1:
                runs[-1][1] = i
            else:
                runs.append([i, i])
    worst = max(range(len(y)), key=lambda i: depth[i])
    out += [f"dark dips (more than {DIP:.0%} below the brightest frame within {DIPWIN} s on both sides): "
            f"{'FAIL' if runs else 'PASS'}, {len(runs)}; worst {depth[worst]:.1%} at {worst / fps:.2f} s",
            *[f"  {a / fps:.2f}-{(b + 1) / fps:.2f} s: low {min(y[a:b + 1]):.1f}, {before(a):.1f} before, {after(b):.1f} after"
              for a, b in runs]]
    bad = bad or bool(runs)
open(f"{c}/checks.txt", "w").write("\n".join(out) + "\n")
print("\n".join(out))
sys.exit(1 if bad else 0)
EOF
rc=$?
set -e
{
  echo "sha256 $SHA $V"
  [ "$rc" = 0 ] && echo "PASS checks: checks.txt" || echo "FAIL checks: checks.txt"
  for n in sync framing overlays; do
    if [ -z "${JOB[$n]:-}" ]; then echo "n/a  $n: no --timeline with shots$([ "$n" != sync ] || echo ", or --timeline with --caption-box")"
    elif wait "${JOB[$n]}"; then echo "PASS $n: $n.log"
    else echo "FAIL $n: $n.log"; rc=1; fi
  done
  if ! wait "${JOB[ocr]}"; then echo "FAIL privacy OCR: ocr.log"; rc=1
  elif [ -s "$C/ocr.txt" ]; then echo "LOOK privacy OCR: hits $(wc -l < "$C/ocr.txt"), compare each with the identities allowed on screen: ocr.txt"
  else echo "PASS privacy OCR: no @, mail or .com read: ocr.txt"; fi
  if [ -z "$SINCE" ]; then :
  elif wait "${JOB[rewatch]}"; then echo "PASS re-watch: same audio and subtitles as $(sha256sum < "$SINCE" | cut -c1-64), no frame changed${ALLOW[*]:+ outside ${ALLOW[*]}}: rewatch.log"
  else echo "LOOK re-watch: $(head -1 "$C/rewatch.log"), so watch the whole export: rewatch.log"; fi
} > "$C/verdict.txt"
cat "$C/verdict.txt"
exit "$rc"
