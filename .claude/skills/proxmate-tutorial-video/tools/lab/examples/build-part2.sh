#!/bin/bash
# Part two, polished cut in both voices: male narration paced to the recording, then assemble with the
# editor's decisions (rec/<take>/fx-edits.json), chapters, and review frames.
# usage: build-part2.sh   (env PMV_WORK = part two's working folder, e.g. ~/pmv/work/part2; TAKE default t2a;
#        SKIP_NARR=1, ONLY_MALE=1, ONLY_FEMALE=1, SKIP_QA=1 skip steps; TITLES default ../../docs/examples/titles-part2.json)
#   The male render used render_matched.py, not packaged (../../voice/render2.py and to_recorder.py replace it):
#   set RENDER_MATCHED to its path to run that step, otherwise it is skipped.
set -u
HERE=$(dirname "$(readlink -f "$0")"); TOOLS=$(dirname "$(dirname "$HERE")")
T=${PMV_WORK:-$HOME/pmv/work}; PY=${PMV_VENV:-$HOME/pmv/venv}/bin/python3; TAKE=${TAKE:-t2a}
OUT=$T/final; mkdir -p $OUT/female $OUT/male
IDS="V01 V02 V03 V04 V05 V06 V07 V08 V09 V10 V11 V12 V13 V14 V15 V16 V17 V18 V19 V20"
step() { echo "== $(date +%H:%M:%S) $*"; }
[ "${SKIP_NARR:-}" ] || [ -z "${RENDER_MATCHED:-}" ] || { step "male narration"
REF_DIR=$T/narr/voice2 TAKE_DIR=$T/rec/$TAKE LINES=$T/narr/lines.json $PY -I $RENDER_MATCHED am_michael $T/narr/voice-am_michael 2>&1 > $T/narr/render-male.log 2>&1; grep -c OOV $T/narr/render-male.log; tail -2 $T/narr/render-male.log; }
build() { # voice voicedir
  step "polished $1"; out=$OUT/$1/proxmate-vms-templates-consoles-$1.mp4
  FX=1 VOICE_DIR=$2 ENDCARD=$TOOLS/edit/endcard/endcard.mp4 python3 $TOOLS/edit/assemble.py $T/rec/$TAKE $out $IDS > $OUT/$1/assemble.log 2>&1 || { echo "FAILED $1"; tail -5 $OUT/$1/assemble.log; exit 1; }
  tail -1 $OUT/$1/assemble.log
}
[ "${ONLY_MALE:-}" ] || build female $T/narr/voice2
[ "${ONLY_FEMALE:-}" ] || build male $T/narr/voice-am_michael
python3 $TOOLS/docs/ytchapters.py ${TITLES:-$TOOLS/docs/examples/titles-part2.json} $OUT/*/*.chapters.json > $OUT/chapters.log 2>&1; tail -1 $OUT/chapters.log
[ "${SKIP_QA:-}" ] || { step "review frames"; rm -rf $T/qa/fx1
python3 $TOOLS/edit/qa_fx.py $T/rec/$TAKE $OUT/female/proxmate-vms-templates-consoles-female.mp4 $T/qa/fx1 2>&1 | tail -4; }
step "done"
