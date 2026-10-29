#!/bin/bash
# Social teaser (LinkedIn): a stretch of the finished video, a 0.5 s fade (as the full video does before its end
# card), then the end card appended without re-encoding, about 30 s in all. The excerpt is re-encoded with the
# assembler's settings so the end card's stream can be joined as is; the audio is the finished mix, faded with the
# picture and silent under the end card. Also writes the excerpt's captions from the full video's .srt.
# usage: teaser.sh <full.mp4> <start s> <end s> <out.mp4> [full.srt]
#   end = just after the last word you keep; the fade covers the last 0.5 s, so leave that much air after the voice
set -euo pipefail
SRC=$1 START=$2 END=$3 OUT=$4 SRT=${5:-${1%.mp4}.srt}
HERE=$(cd "$(dirname "$0")" && pwd); CARD=$HERE/endcard/endcard.mp4
LEN=$(python3 -c "print(round($END - $START, 3))"); FADE=$(python3 -c "print(round($LEN - 0.5, 3))")
CARDLEN=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CARD")
TOTAL=$(python3 -c "print(round($LEN + $CARDLEN, 3))")
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
ffmpeg -loglevel error -y -ss "$START" -t "$LEN" -i "$SRC" -map 0:v -vf "fade=t=out:st=$FADE:d=0.5" \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -g 60 -bf 2 -colorspace bt709 -color_primaries bt709 \
  -color_trc bt709 -color_range tv -r 30 -an -video_track_timescale 15360 "$T/part.mp4"
printf "file '%s'\nfile '%s'\n" "$T/part.mp4" "$CARD" > "$T/list.txt"
ffmpeg -loglevel error -y -f concat -safe 0 -i "$T/list.txt" -c copy "$T/video.mp4"
ffmpeg -loglevel error -y -ss "$START" -t "$LEN" -i "$SRC" -map 0:a -af "afade=t=out:st=$FADE:d=0.5,apad=whole_dur=$TOTAL" \
  -ar 48000 -ac 2 -c:a aac -b:a 192k "$T/audio.m4a"
ffmpeg -loglevel error -y -i "$T/video.mp4" -i "$T/audio.m4a" -map 0:v -map 1:a -c copy -movflags +faststart "$OUT"
# the end card must come through frame for frame
N=$(python3 -c "print(round($LEN * 30))")
cmp -s <(ffmpeg -loglevel error -i "$OUT" -map 0:v -vf "select=gte(n\,$N)" -vsync 0 -f framemd5 - | grep -v '^#' | awk -F, '{print $NF}') \
       <(ffmpeg -loglevel error -i "$CARD" -map 0:v -f framemd5 - | grep -v '^#' | awk -F, '{print $NF}') \
  && echo "end card: identical" || { echo "end card frames differ" >&2; exit 1; }
if [ -f "$SRT" ]; then python3 - "$SRT" "$START" "$END" "${OUT%.mp4}.srt" <<'EOF'
import sys
src, a0, a1, out = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
def sec(x): h, m, s = x.split(":"); s, ms = s.split(","); return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000
def st(t): ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000); return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
cues = []
for c in open(src).read().strip().split("\n\n"):
    ls = c.split("\n"); a, z = [sec(x) for x in ls[1].split(" --> ")]
    if a >= a0 and a < a1: cues.append(f"{len(cues) + 1}\n{st(a - a0)} --> {st(min(z, a1) - a0)}\n" + "\n".join(ls[2:]))
open(out, "w").write("\n\n".join(cues) + "\n"); print(f"{out}: {len(cues)} captions")
EOF
fi
echo "$OUT: $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT") s"
