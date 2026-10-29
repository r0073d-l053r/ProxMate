#!/usr/bin/env bash
# Build the pronunciation lexicon Kokoro reads: lexicon-additions.txt (our words) first, then the model's own US
# English lexicon. sherpa-onnx and render2.py keep the first entry of a word, so an addition wins over the model's.
# usage: build_lexicon.sh [out]   (env PMV_MODELS, default ~/pmv/models; out default $PMV_LEXICON,
#        default $PMV_MODELS/lexicon-us-en-lab.txt)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
MODELS=${PMV_MODELS:-$HOME/pmv/models}
OUT=${1:-${PMV_LEXICON:-$MODELS/lexicon-us-en-lab.txt}}
SRC=$MODELS/kokoro-multi-lang-v1_0/lexicon-us-en.txt
ADDS=$HERE/lexicon-additions.txt
[ -f "$SRC" ] || { echo "missing $SRC: run setup.sh first (or set PMV_MODELS)" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
{ grep -v '^[[:space:]]*$' "$ADDS" || true; cat "$SRC"; } > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
echo "$OUT: $(wc -l < "$OUT") lines, $(grep -cv '^[[:space:]]*$' "$ADDS") from lexicon-additions.txt"
