#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Prove nothing but the allowlisted marks is drawn over the page: click rings and outline-only highlights.

    overlays.py TIMELINE.json [--video V.mp4] [--out DIR] [--per-second 2]
    overlays.py --self-test

Reads the timeline contract (see _media.py); its "marks" are the complete allowlist. For every frame sampled
by index, the shot's view is compared pixel by pixel with the take frame the timeline names, resized whole
(best of three neighbouring take frames, per pixel). A pixel is changed when its largest channel difference
exceeds DIFF.

Tiles: a BLOCK x BLOCK tile outside every scheduled mark (grown PAD px) with at least FOREIGN of its pixels
changed is a foreign overlay: a card, a label, a blur, a tint over the page.
Interiors: inside each outline box, inset INSET px past its stroke, the per-channel median of export - take
must stay within TINT. A fill shifts every interior pixel one way and moves the median; a caret does not.

Both detectors prove they can fail on every run: an opaque card (360 x 110 px, or smaller on a small view,
in a colour that contrasts with the page under it) pasted where no mark is must be caught in every sampled
frame that has room for it, and a faint fill (the mark's colour at alpha 26 of 255, or its complement where
the page already has that colour) composited into every outline interior must be caught. A blind detector
fails the check. Limit: a plain box within DIFF of the page under it (a bare white box on a white page) is
below the tile detector; a card with text or a border is caught. Look at full-resolution frames too.
Writes DIR/overlays.md and DIR/overlays.json. Exit 0 on pass.
"""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _media  # noqa: E402

DIFF, PAD, BLOCK, FOREIGN, INSET, TINT, FAINT_ALPHA = 48, 8, 16, 0.25, 8, 3.0, 26


def chmax(d: np.ndarray) -> np.ndarray:
    """numpy's max(axis=2) over a 3-wide axis is about 15x slower than two np.maximum calls."""
    a = np.abs(d)
    return np.maximum(np.maximum(a[..., 0], a[..., 1]), a[..., 2])


def changed(crop, srcs):
    vh, vw = crop.shape[:2]
    got = crop.astype(np.int16)
    best = signed = None
    for src in srcs:
        if src.shape[:2] != (vh, vw):
            src = np.asarray(Image.fromarray(src).resize((vw, vh), Image.LANCZOS))
        diff = got - src
        dd = chmax(diff)
        if best is None:
            best, signed = dd, diff
        else:
            np.copyto(signed, diff, where=(dd < best)[..., None])
            best = np.minimum(dd, best)
    return best, signed


def foreign(ch: np.ndarray, allow: np.ndarray) -> list[tuple[int, int]]:
    vh, vw = ch.shape
    hb, wb = vh // BLOCK, vw // BLOCK
    c = ch[:hb * BLOCK, :wb * BLOCK].reshape(hb, BLOCK, wb, BLOCK).mean(axis=(1, 3))
    a = allow[:hb * BLOCK, :wb * BLOCK].reshape(hb, BLOCK, wb, BLOCK).any(axis=(1, 3))
    ys, xs = np.where((c >= FOREIGN) & ~a)
    return [(int(x * BLOCK), int(y * BLOCK)) for y, x in zip(ys, xs)]


def interiors(marks, view):
    vx, vy, vw, vh = view
    outs = [m for m in marks if m["kind"] == "outline"]
    blocked = _media.view_mask([m for m in marks if m["kind"] == "ring"], view, PAD)
    res = []
    for m in outs:
        x0, y0, x1, y1 = m["box"]
        inner = Image.new("L", (vw, vh), 0)
        if x1 - x0 > 2 * INSET and y1 - y0 > 2 * INSET:
            ImageDraw.Draw(inner).rectangle([x0 - vx + INSET, y0 - vy + INSET, x1 - vx - INSET, y1 - vy - INSET], fill=255)
        inn = np.asarray(inner) > 0
        for o in outs:  # other outlines' stroke bands
            if o is not m:
                band = _media.view_mask([o], view, PAD) & ~(_media.view_mask([o], view, -INSET))
                blocked = blocked | band
        res.append((m, inn & ~blocked))
    return res


def median_shift(signed, mask=...):
    med = [float(np.median(signed[..., c][mask])) for c in range(3)]
    return med, max(abs(v) for v in med)


def card_spot(allow, vw, vh):
    cw, chh = min(360, vw // 3), min(110, vh // 4)
    for cx, cy in ((vw - cw - 24, vh // 5), (24, vh // 5), (vw - cw - 24, vh - chh - 24), (24, vh - chh - 24),
                   ((vw - cw) // 2, (vh - chh) // 2)):
        if not allow[cy:cy + chh, cx:cx + cw].any():
            return cx, cy, cw, chh
    return None


def run(timeline: Path, video: Path | None, out: Path, per_second: int):
    tl = _media.Timeline(timeline)
    video = video or tl.video
    step = max(1, round(tl.fps / per_second))

    def sample(n, crop, shot, srcs):
        t = n / tl.fps
        cards, inside, fills = [], [], []
        view = shot["view"]
        vw, vh = view[2:]
        marks = tl.marks_at(t)
        allow = _media.view_mask(marks, view, PAD)
        best, signed = changed(crop, srcs)
        fb = foreign(best > DIFF, allow)
        row = {"frame": n, "t": round(t, 3), "marks": len(marks), "foreign_tiles": len(fb), "first": fb[:3]}
        spot = card_spot(allow, vw, vh)
        if spot:
            cx, cy, cw, chh = spot
            card = (slice(cy, cy + chh), slice(cx, cx + cw))
            under = crop[card].astype(np.int16)
            best_take = under - signed[card]
            dd = best.copy()
            contrast_paint = np.where(under.reshape(-1, 3).mean(axis=0) > 127, 15, 240)
            dd[card] = chmax(contrast_paint - best_take)
            hits = [b for b in foreign(dd > DIFF, allow) if cx <= b[0] < cx + cw and cy <= b[1] < cy + chh]
            cards.append({"frame": n, "caught_tiles": len(hits), "tiles": (cw // BLOCK) * (chh // BLOCK)})
        for mk, m in interiors(marks, view):
            if not m.sum():
                continue
            med, worst = median_shift(signed, m)
            inside.append({"frame": n, "t": round(t, 3), "box": [round(v) for v in mk["box"]], "median_rgb": med,
                           "shift": worst, "tinted": worst > TINT})
            a = FAINT_ALPHA / 255
            region = crop[m].astype(np.float32)
            col = np.array(mk.get("color", [37, 99, 235]), np.float32)
            delta = lambda c: (np.round(region * (1 - a) + c * a).astype(np.int16)  # noqa: E731
                               - region.astype(np.int16))
            if median_shift(delta(col))[1] <= 2 * TINT:
                col = 255 - col
            fills.append({"frame": n, "box": [round(v) for v in mk["box"]], "colour": col.tolist(),
                          "shift": median_shift(signed[m] + delta(col))[1]})
        return row, median_shift(signed, ~allow)[1], cards, inside, fills

    done = _media.map_frames(tl, video, step, sample)
    rows, floor = [d[0] for d in done], [d[1] for d in done]
    cards, inside, fills = ([r for d in done for r in d[k]] for k in (2, 3, 4))
    bad = [r for r in rows if r["foreign_tiles"]]
    blind_card = [c for c in cards if c["caught_tiles"] * 2 < c["tiles"]]
    tinted = [r for r in inside if r["tinted"]]
    blind_fill = [f for f in fills if f["shift"] <= TINT]
    ok_tiles = bool(rows) and bool(cards) and not bad and not blind_card
    ok_inside = not tinted and not blind_fill and (bool(fills) or not any(
        m["kind"] == "outline" for m in tl.d.get("marks", [])))
    ok = ok_tiles and ok_inside
    out.mkdir(parents=True, exist_ok=True)
    sha = hashlib.sha256(Path(video).read_bytes()).hexdigest()
    (out / "overlays.json").write_text(json.dumps({"video": str(video), "sha256": sha, "rows": rows, "card_test": cards,
                                                   "interiors": inside, "fill_test": fills, "noise_floor": floor}, indent=1))
    md = ["# Overlays: only click rings and outline highlights over the page", "",
          f"Source: {video} (sha256 `{sha[:16]}…`), every {step}th frame by index ({len(rows)} frames).", "",
          f"Opaque-card self-test: caught in {len(cards) - len(blind_card)} of {len(cards)} frames with room for a card.",
          f"Frames with a foreign overlay: {len(bad)} of {len(rows)}.",
          *[f"- frame {r['frame']} ({r['t']} s): {r['foreign_tiles']} tiles, first at view px {r['first']}" for r in bad[:20]],
          f"Tiles: {'PASS' if ok_tiles else 'FAIL'}", "",
          f"Faint-fill self-test (alpha {FAINT_ALPHA}/255): caught in {len(fills) - len(blind_fill)} of {len(fills)} "
          f"outline interiors (smallest shift {min([f['shift'] for f in fills] or [0]):.1f}, bar {TINT}).",
          f"Noise floor outside every mark: max median shift {max(floor or [0]):.1f}.",
          f"Outline interiors measured: {len(inside)}; tinted past ±{TINT}: {len(tinted)}.",
          *[f"- frame {r['frame']} ({r['t']} s) box {r['box']}: median {[round(v, 1) for v in r['median_rgb']]}"
            for r in tinted[:20]],
          f"Interiors: {'PASS' if ok_inside else 'FAIL'}", "", f"Verdict: {'PASS' if ok else 'FAIL'}"]
    (out / "overlays.md").write_text("\n".join(md) + "\n")
    return ok, md


def self_test() -> int:
    fails = []
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        tw, th, fps, secs = 480, 300, 30, 2.0
        _media.synth_take(d / "take.mp4", tw, th, secs, fps)
        takes = [f[1] for f in _media.decode(d / "take.mp4")]
        view = [20, 10, tw, th]
        box = [60, 60, 300, 120]   # canvas px: the outline mark
        marks = [{"kind": "outline", "t0": 0.0, "t1": secs, "box": box, "color": [37, 99, 235]},
                 {"kind": "ring", "t0": 0.5, "t1": 1.15, "center": [400, 200], "radius": 47}]

        def export(name, extra):
            def frames():
                for k in range(int(secs * fps)):
                    canvas = Image.new("RGBA", (520, 320), (226, 232, 240, 255))
                    canvas.paste(Image.fromarray(takes[min(k, len(takes) - 1)]).convert("RGBA"), (view[0], view[1]))
                    top = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
                    dr = ImageDraw.Draw(top)
                    dr.rounded_rectangle(box, 8, outline=(37, 99, 235, 235), width=3)
                    if 0.5 <= k / fps <= 1.15:
                        dr.ellipse([380, 180, 420, 220], outline=(37, 99, 235, 200), width=5)
                    extra(dr, k)
                    yield np.asarray(Image.alpha_composite(canvas, top).convert("RGB"))
            _media.write_video(d / f"{name}.mp4", frames(), 520, 320, fps)
            tl = {"video": str(d / f"{name}.mp4"), "fps": fps, "canvas": [520, 320], "total": secs, "marks": marks,
                  "shots": [{"take": str(d / "take.mp4"), "size": [tw, th], "view": view, "out0": 0, "out1": secs,
                             "pieces": [[0, secs, 0, secs]]}]}
            (d / f"{name}.json").write_text(json.dumps(tl))
            return run(d / f"{name}.json", None, d / name, 4)[0]

        if not export("clean", lambda dr, k: None):
            fails.append("rings and outlines only: failed")
        if export("card", lambda dr, k: dr.rounded_rectangle([330, 240, 470, 300], 12, fill=(15, 23, 42, 240))
                  if k >= fps else None):
            fails.append("an opaque card over the page for one second passed")
        if export("tint", lambda dr, k: dr.rectangle([64, 64, 296, 116], fill=(37, 99, 235, 30))):
            fails.append("a faint fill inside the outline passed")
    print("overlays.py self-test: " + ("PASS" if not fails else "FAIL\n  " + "\n  ".join(fails)))
    return 0 if not fails else 1


def arg(a, name, default=None):
    return a[a.index(name) + 1] if name in a else default


def main() -> int:
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if a[0] == "--self-test":
        return self_test()
    tl = Path(a[0]).resolve()
    video = Path(arg(a, "--video")).resolve() if "--video" in a else None
    ok, md = run(tl, video, Path(arg(a, "--out", tl.parent / "checks")), int(arg(a, "--per-second", 2)))
    print("\n".join(md))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
