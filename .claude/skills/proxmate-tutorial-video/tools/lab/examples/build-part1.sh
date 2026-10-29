#!/bin/bash
# Part one's final build: all four deliverables after the S03 first-try retakes, the "Deploy" line and the editor's
# fixes: plain (take4) and polished (take5 + rec/take5/fx-edits.json), each in the female and male voice.
# usage: build-part1.sh   (env PMV_WORK = part one's working folder; TITLES = chapter titles json for ytchapters.py,
#        default $PMV_WORK/titles.json; SKIP_NARR=1 skips the male re-render, SKIP_PLAIN=1 the plain cut)
#   The male S03/S13 re-render used part one's render_matched.py, not packaged (../../voice/render2.py and
#   to_recorder.py replace it): set RENDER_MATCHED to its path to run that step, otherwise it is skipped.
set -u
HERE=$(dirname "$(readlink -f "$0")"); TOOLS=$(dirname "$(dirname "$HERE")")
D=${PMV_WORK:-$HOME/pmv/work}; PY=${PMV_VENV:-$HOME/pmv/venv}/bin/python
cd $D; for v in plain polished; do mkdir -p final-v4/$v/female final-v4/$v/male; done
step() { echo "== $(date +%H:%M:%S) $*"; }
[ "${SKIP_NARR:-}" ] || [ -z "${RENDER_MATCHED:-}" ] || { step "male narration: S03 and S13 for both takes"
SEGMENTS=S03,S13 TAKE_DIR=$D/rec/take4 $PY -I $RENDER_MATCHED am_michael narr/voice-am_michael 2>&1 | grep -v "^@@" | tail -1
SEGMENTS=S03,S13 TAKE_DIR=$D/rec/take5 $PY -I $RENDER_MATCHED am_michael narr/voice-am_michael-take5 2>&1 | grep -v "^@@" | tail -1; }
build() { # cut voice take fx voicedir
  step "$1 $2"; out=final-v4/$1/$2/proxmate-setup-tutorial-$2.mp4
  FX=$4 VOICE_DIR=$5 ENDCARD=$TOOLS/edit/endcard/endcard.mp4 python3 $TOOLS/edit/assemble.py $D/rec/$3 $D/$out > final-v4/$1/$2/assemble.log 2>&1 || { echo "FAILED $1 $2"; tail -5 final-v4/$1/$2/assemble.log; exit 1; }
  tail -1 final-v4/$1/$2/assemble.log
}
[ "${SKIP_PLAIN:-}" ] || { build plain female take4 0 $D/narr/voice; build plain male take4 0 $D/narr/voice-am_michael; }
build polished female take5 1 $D/narr/voice
build polished male take5 1 $D/narr/voice-am_michael-take5
python3 $TOOLS/docs/ytchapters.py ${TITLES:-$D/titles.json} final-v4/*/*/*.chapters.json | grep -v "^0\|^1" | head -4
step "review frames"; rm -rf qa/v8 qa/p8
python3 $TOOLS/edit/qa_fx.py $D/rec/take5 $D/final-v4/polished/female/proxmate-setup-tutorial-female.mp4 $D/qa/v8 2>&1 | tail -16
python3 $TOOLS/edit/qa_fx.py $D/rec/take4 $D/final-v4/plain/female/proxmate-setup-tutorial-female.mp4 $D/qa/p8 2>&1 | tail -16
step "done"
