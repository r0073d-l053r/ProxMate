# Shared paths for the tutorial-video tools. Every value comes from an environment variable or a default:
#   PMV_MODELS   models folder (default ~/pmv/models): Kokoro, Moonshine and the built lexicon live here
#   PMV_LEXICON  pronunciation lexicon Kokoro reads (default $PMV_MODELS/lexicon-us-en-lab.txt, made by voice/build_lexicon.sh)
#   PMV_WORK     per-video working folder (default ~/pmv/work): beats.json, narration drafts, voice renders, QA files
# usage (from a tool in tools/<area>/):
#   sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); import pmv_env
#   pmv_env.KOKORO_DIR, pmv_env.MOONSHINE_DIR, pmv_env.LEXICON, pmv_env.WORK, pmv_env.FONT_BOLD, pmv_env.FONT_REGULAR
import glob, os

TOOLS = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.expanduser(os.environ.get("PMV_MODELS") or "~/pmv/models")
KOKORO_DIR = os.path.join(MODELS, "kokoro-multi-lang-v1_0")
_moon = sorted(glob.glob(os.path.join(MODELS, "sherpa-onnx-moonshine-*")))
MOONSHINE_DIR = _moon[0] if _moon else None  # None until voice/setup.sh has downloaded it
LEXICON = os.path.expanduser(os.environ.get("PMV_LEXICON") or os.path.join(MODELS, "lexicon-us-en-lab.txt"))
WORK = os.path.expanduser(os.environ.get("PMV_WORK") or "~/pmv/work")
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def require(path, what):
    """Exit with a hint when a model or lexicon is missing; returns the path otherwise."""
    if not path or not os.path.exists(path):
        raise SystemExit(f"{what} not found ({path or os.path.join(MODELS, 'sherpa-onnx-moonshine-*')}). "
                         f"Run {os.path.join(TOOLS, 'voice', 'setup.sh')} or set PMV_MODELS / PMV_LEXICON.")
    return path


def moonshine():
    """The Moonshine model folder, or exit with a hint."""
    return require(MOONSHINE_DIR, "Moonshine speech recognition model")
