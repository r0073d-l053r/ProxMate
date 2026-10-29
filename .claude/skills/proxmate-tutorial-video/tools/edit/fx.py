"""Editing effects for one real-time span of a chapter capture: click ripples and eased zooms.

The recorder logs every real click (where the pointer was, when) and the moments a chapter wants the viewer
to look closer (a screen rectangle). This decodes the span frame by frame, draws a soft ring where each click
landed, eases the view in on a rectangle and back out, and pipes the frames to the same encoder settings the
rest of the video uses. The zoom box moves with sub-pixel precision (PIL resize with a float box), so there is
no stepping. Spans without any click or zoom never come through here.

usage: a module, not a command. assemble.py imports it when FX=1 (render_span, ripple_times, target_box) and
qa_fx.py uses it to find where each ripple and zoom lands. Editing this file re-renders every effects part
(its source is part of assemble.py's cache key).
"""
import math, subprocess
from PIL import Image, ImageDraw

W, H, FPS = 1920, 1080, 30
EASE = 0.55          # seconds to ease in or out of a zoom
MAX_ZOOM = 1.9       # "occasional cropping": never so tight that context disappears
RIPPLE_S = 0.48      # ripple length in seconds

def _ripple_frames():
    """Precomputed ripple sprites (RGBA), drawn at 4x and downsampled so the ring is antialiased."""
    n = int(round(RIPPLE_S * FPS)); size = 84; k = 4; out = []
    for i in range(n):
        u = (i + 1) / n; e = 1 - (1 - u) ** 3                      # ease-out growth
        r = (7 + 27 * e) * k; a = (1 - u) ** 1.4
        im = Image.new("RGBA", (size * k, size * k), (0, 0, 0, 0)); d = ImageDraw.Draw(im); c = size * k / 2
        d.ellipse([c - r - 2 * k, c - r - 2 * k, c + r + 2 * k, c + r + 2 * k], outline=(20, 24, 30, int(110 * a)), width=2 * k)  # dark edge: visible on light UI
        d.ellipse([c - r, c - r, c + r, c + r], outline=(255, 255, 255, int(235 * a)), width=3 * k)
        if u < 0.45:
            rd = (5 + 6 * e) * k; d.ellipse([c - rd, c - rd, c + rd, c + rd], fill=(255, 255, 255, int(90 * (1 - u / 0.45))))
        out.append(im.resize((size, size), Image.LANCZOS))
    return out

RIPPLE = None

def _smooth(u):
    u = min(1.0, max(0.0, u)); return u * u * (3 - 2 * u)

def target_box(rect, pad=1.3):
    """The view box (x0, y0, x1, y1) that frames `rect` (x, y, w, h) at 16:9, padded, clamped to the screen."""
    x, y, w, h = rect; cx, cy = x + w / 2, y + h / 2
    z = max(1.0, min(MAX_ZOOM, W / (w * pad), H / (h * pad)))
    bw, bh = W / z, H / z
    x0 = min(max(cx - bw / 2, 0), W - bw); y0 = min(max(cy - bh / 2, 0), H - bh)
    return (x0, y0, x0 + bw, y0 + bh)

CUT_FADE = 0.07     # how fast a ripple fades once the page under it changes

def click_change(src, press, x, y, within=0.45, r=100, level=10.0):
    """Seconds after `press` until the 200x200 area around (x, y) changes a lot (a page or layout switch),
    or None. Measured on the lossless capture against the frame just before the press."""
    x, y = min(max(int(x), r), W - r), min(max(int(y), r), H - r); n = int(within * FPS) + 1
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", f"{max(0.0, press - 1 / FPS):.3f}", "-i", src, "-frames:v", str(n + 1),
                          "-vf", f"crop={2*r}:{2*r}:{x-r}:{y-r}", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
    sz = (2 * r) ** 2; fr = [raw[i:i + sz] for i in range(0, len(raw) - sz + 1, sz)]
    for i in range(1, len(fr)):
        if sum(abs(a - b) for a, b in zip(fr[i], fr[0])) / sz > level: return (i - 1) / FPS
    return None

_AUTO = object()

def ripple_times(src, press, x, y, dt=_AUTO):
    """(start, cut) for one click's ripple. Most clicks: the ring starts at the press. A click that swaps the
    page under the pointer within 0.4 s (Continue, Finish, Confirm) gets its ring a moment earlier, while the
    pointer already rests on the button, and fades out as the page changes, so it is seen on the button and
    not on whatever replaces it."""
    if dt is _AUTO: dt = click_change(src, press, x, y)  # or the editor's own reading of the frames
    if dt is None or dt >= 0.40: return press, None
    return press - min(0.10, max(0.0, 0.22 - dt)), press + dt

def view_at(t, zooms):
    """View box at chapter time t. zooms: [(t_in, t_out, box)], non-overlapping."""
    full = (0.0, 0.0, float(W), float(H))
    for t_in, t_out, box in zooms:
        if t < t_in or t > t_out + EASE: continue
        e = _smooth((t - t_in) / EASE) * (1 - _smooth((t - t_out) / EASE))
        # Scale about the one screen point the full view and the target box share, with the size eased
        # geometrically (the zoom feels even). Every in-between box then stays inside the screen without
        # clamping, so an edge the target touches (the dock, the top bar) stays put instead of drifting.
        st = (box[2] - box[0]) / W
        if st > 0.999: return full
        px, py = box[0] / (1 - st), box[1] / (1 - st); s = st ** e
        return (px * (1 - s), py * (1 - s), px * (1 - s) + W * s, py * (1 - s) + H * s)
    return full

def render_span(src, s0, s1, clicks, zooms, out, encode_args, vf_after):
    """Decode src[s0:s1] at 30 fps, apply effects, encode to `out`.

    clicks: [(start, x, y, cut)] in chapter seconds and screen pixels (cut: None, or when to fade the ring
    out, see ripple_times); zooms: [(t_in, t_out, box)].
    vf_after: the colour-conversion filter chain the normal path uses (applied in the encoder).
    """
    global RIPPLE
    if RIPPLE is None: RIPPLE = _ripple_frames()
    dec = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-ss", f"{s0:.3f}", "-to", f"{s1:.3f}", "-i", src,
                            "-vf", f"setpts=PTS-STARTPTS,fps={FPS}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
                            "-i", "-", "-vf", vf_after] + encode_args + [out], stdin=subprocess.PIPE)
    fsz = W * H * 3; i = 0; rh = RIPPLE[0].size[0] // 2
    try:
        while True:
            buf = dec.stdout.read(fsz)
            if len(buf) < fsz: break
            t = s0 + i / FPS; i += 1
            live = [(ct, cx, cy, cut) for ct, cx, cy, cut in clicks if 0 <= t - ct < RIPPLE_S and (cut is None or t < cut + CUT_FADE)]
            box = view_at(t, zooms)
            if not live and box == (0.0, 0.0, float(W), float(H)):
                enc.stdin.write(buf); continue
            im = Image.frombuffer("RGB", (W, H), buf, "raw", "RGB", 0, 1).convert("RGBA")
            for ct, cx, cy, cut in live:
                spr = RIPPLE[min(len(RIPPLE) - 1, int((t - ct) * FPS))]
                if cut is not None and t > cut:  # the page changed under the ring: fade it out fast
                    f = max(0.0, 1 - (t - cut) / CUT_FADE); spr = spr.copy(); spr.putalpha(spr.getchannel("A").point(lambda v: int(v * f)))
                x0, y0 = int(round(cx)) - rh, int(round(cy)) - rh
                # clip the sprite at the screen edge (the dock sits at x < 66)
                l, tp = max(0, -x0), max(0, -y0); r, b = min(spr.size[0], W - x0), min(spr.size[1], H - y0)
                if r > l and b > tp: im.alpha_composite(spr.crop((l, tp, r, b)), (x0 + l, y0 + tp))
            im = im.convert("RGB")
            if box != (0.0, 0.0, float(W), float(H)):
                im = im.resize((W, H), Image.LANCZOS, box=box)
            enc.stdin.write(im.tobytes())
    finally:
        enc.stdin.close(); dec.stdout.close()
        rc1, rc2 = dec.wait(), enc.wait()
    if rc2 != 0: raise SystemExit(f"encode failed for {out}")
    return i
