#!/usr/bin/env bash
# One-time setup for the voice and QA tools: a Python venv with the exact packages parts one and two were made
# with, the Kokoro TTS model (kokoro-multi-lang-v1_0), the Moonshine speech recogniser
# (sherpa-onnx-moonshine-base-en-int8), and the pronunciation lexicon (build_lexicon.sh). Safe to run again:
# whatever is already there is kept.
# usage: setup.sh   (env PMV_VENV, default ~/pmv/venv; PMV_MODELS, default ~/pmv/models;
#        PMV_LEXICON, default $PMV_MODELS/lexicon-us-en-lab.txt)
# Needs about 1 GB free while the Kokoro archive (350 MB) unpacks; the archives are deleted after unpacking.
# Not installed here (system packages the tools also use): python3 with venv (3.13 was used), curl, tar with bzip2,
# ffmpeg/ffprobe, espeak-ng (lexadd.py, lexgen.py), Pillow for the system python3 (sheets.py, build_beats.py,
# apt package python3-pil) and fonts-dejavu-core.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
VENV=${PMV_VENV:-$HOME/pmv/venv}
MODELS=${PMV_MODELS:-$HOME/pmv/models}
REL=https://github.com/k2-fsa/sherpa-onnx/releases/download

for t in python3 curl tar bzip2 ffmpeg ffprobe espeak-ng; do
  command -v "$t" >/dev/null || echo "warning: $t not found" >&2
done
python3 -c "import PIL" 2>/dev/null || echo "warning: the system python3 has no Pillow (apt install python3-pil)" >&2
[ -f /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf ] || echo "warning: DejaVu fonts missing (apt install fonts-dejavu-core)" >&2

# 1. venv: sherpa-onnx and its runtime, numpy, soundfile, and their dependencies, at the versions used so far
[ -x "$VENV/bin/python3" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --no-input \
  sherpa-onnx==2.0.0 sherpa-onnx-core==2.0.0 numpy==2.5.4 soundfile==0.14.0 \
  cffi==2.1.1 pycparser==3.12 typing_extensions==4.16.0
"$VENV/bin/python3" -c "import sherpa_onnx, numpy, soundfile; print('venv ok:', sherpa_onnx.__file__)"

# 2. models
mkdir -p "$MODELS"
fetch() {  # <release folder> <model name>
  if [ -d "$MODELS/$2" ]; then echo "have $MODELS/$2"; return; fi
  curl -fL --retry 3 -o "$MODELS/$2.tar.bz2" "$REL/$1/$2.tar.bz2"
  tar xjf "$MODELS/$2.tar.bz2" -C "$MODELS"
  rm -f "$MODELS/$2.tar.bz2"
  echo "unpacked $MODELS/$2"
}
fetch tts-models kokoro-multi-lang-v1_0
fetch asr-models sherpa-onnx-moonshine-base-en-int8

# 3. lexicon: our additions first, then Kokoro's US English lexicon
PMV_MODELS="$MODELS" "$HERE/build_lexicon.sh"

echo "ready. Run the voice and QA tools with $VENV/bin/python3; export PMV_MODELS=$MODELS if it is not the default."
