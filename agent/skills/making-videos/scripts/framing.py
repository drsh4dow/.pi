#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Prove the export shows each take's whole viewport at one scale and place: no zoom, pan or crop.

    framing.py TIMELINE.json [--video V.mp4] [--out DIR] [--per-second 2]
    framing.py --self-test

Reads the timeline contract (see _media.py). Two witnesses:
1. One scale: every shot's view is its take's size times the same factor (within 0.5 %), and takes of one
   size sit in one place.
2. Pixels: frames of the export, selected by index (per-second samples, no time resampling), are compared in
   the shot's view with the take frame the timeline names, resized whole (best of that frame and its two
   neighbours). The same comparison against that take frame zoomed 1.1x on its centre, and shifted 8 px, shows
   what a zoom or a pan would score. Every sampled frame must match the fixed picture better than both.

Writes DIR/framing.md and DIR/framing.json (DIR defaults to checks/ beside the timeline). Exit 0 on pass.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _media  # noqa: E402

MODES = ("fixed", "zoom1.1", "shift8")


def expected(src: Image.Image, size: tuple) -> dict:
    w, h = src.size
    cw, ch = w / 1.1, h / 1.1
    zoom = src.crop(((w - cw) / 2, (h - ch) / 2, (w + cw) / 2, (h + ch) / 2))
    fixed, zoom = (np.asarray(i.resize(size, Image.LANCZOS).convert("RGB")).astype(np.int16) for i in (src, zoom))
    return {"fixed": fixed, "zoom1.1": zoom, "shift8": np.roll(fixed, 8, axis=1)}


def scale_errors(tl: _media.Timeline) -> list[str]:
    errs, places = [], {}
    ks = [(s["view"][2] / s["size"][0], s["view"][3] / s["size"][1]) for s in tl.shots]
    k0 = ks[0][0]
    for s, (kx, ky) in zip(tl.shots, ks):
        if abs(kx - k0) / k0 > 0.005 or abs(ky - k0) / k0 > 0.005:
            errs.append(f"{Path(s['take']).name}: view {s['view']} is scale {kx:.4f} x {ky:.4f}, first shot {k0:.4f}")
        places.setdefault(tuple(s["size"]), set()).add(tuple(s["view"]))
    errs += [f"takes of size {k} sit in {len(v)} places: {sorted(v)}" for k, v in places.items() if len(v) > 1]
    return errs


def run(timeline: Path, video: Path | None, out: Path, per_second: int) -> tuple[bool, list[str]]:
    tl = _media.Timeline(timeline)
    video = video or tl.video
    step = max(1, round(tl.fps / per_second))

    def sample(n, crop, shot, srcs):
        got = crop.astype(np.int16)
        scores = {}
        for src in srcs:
            for mode, want in expected(Image.fromarray(src), tuple(shot["view"][2:])).items():
                scores[mode] = min(scores.get(mode, 1e9), float(np.abs(got - want).mean()))
        return {"frame": n, "t": round(n / tl.fps, 3), "take": Path(shot["take"]).name, **scores}

    rows = _media.map_frames(tl, video, step, sample)
    errs = scale_errors(tl)
    beaten = [r for r in rows if r["fixed"] < min(r["zoom1.1"], r["shift8"])]
    worst = max(rows, key=lambda r: r["fixed"]) if rows else None
    ok = bool(rows) and not errs and len(beaten) == len(rows)
    out.mkdir(parents=True, exist_ok=True)
    (out / "framing.json").write_text(json.dumps({"video": str(video), "rows": rows, "scale_errors": errs}, indent=1))
    col = lambda m: np.array([r[m] for r in rows]) if rows else np.zeros(1)  # noqa: E731
    md = ["# Framing: whole viewport, one scale, one place", "",
          f"Source: {video}, every {step}th frame by index ({len(rows)} frames). Per-frame numbers: framing.json.", "",
          f"One scale across {len(tl.shots)} shots: " + ("yes" if not errs else "NO"), *[f"- {e}" for e in errs], "",
          "| Expected picture | Median MAD | Max MAD |", "| --- | --- | --- |",
          *[f"| {m} | {np.median(col(m)):.2f} | {col(m).max():.2f} |" for m in MODES], "",
          f"Frames where the fixed picture beats both the zoom and the shift: {len(beaten)} of {len(rows)}."]
    if worst:
        md.append(f"Worst fixed-scale frame: {worst['frame']} ({worst['t']} s, {worst['take']}), MAD {worst['fixed']:.2f}.")
    md += ["", f"Verdict: {'PASS' if ok else 'FAIL'}"]
    (out / "framing.md").write_text("\n".join(md) + "\n")
    return ok, md


def self_test() -> int:
    fails = []
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        tw, th, fps, secs = 320, 200, 30, 2.0
        pages = [_media.synth_page(tw, th, k / fps, fps) for k in range(int(secs * fps))]
        # its second second sits 5 px left, so a stale frame from it reads as a pan once a shot goes back
        _media.write_video(d / "take.mp4", pages[:fps] + [np.roll(p, -5, axis=1) for p in pages[fps:]], tw, th, fps)
        view = [40, 20, 480, 300]
        takes = [np.asarray(f[1]) for f in _media.decode(d / "take.mp4")]

        def export(name, mode, back=False):
            def frames():
                for k in range(int(secs * fps)):
                    canvas = Image.new("RGB", (560, 360), (226, 232, 240))
                    src = Image.fromarray(takes[(k + fps) % len(takes) if back else min(k, len(takes) - 1)])
                    m = mode if k >= fps else "fixed"   # the second second goes wrong
                    refs = expected(src, (480, 300))
                    v = np.roll(refs["fixed"], 12, axis=1) if m == "pan12" else refs[m]
                    canvas.paste(Image.fromarray(v.astype(np.uint8)), (view[0], view[1]))
                    yield np.asarray(canvas)
            _media.write_video(d / f"{name}.mp4", frames(), 560, 360, fps)
            tl = {"video": str(d / f"{name}.mp4"), "fps": fps, "canvas": [560, 360], "total": secs,
                  "shots": [{"take": str(d / "take.mp4"), "size": [tw, th], "view": view, "out0": 0, "out1": secs,
                             "pieces": [[0, 1, 1, secs], [1, secs, 0, 1]] if back else [[0, secs, 0, secs]]}]}
            (d / f"{name}.json").write_text(json.dumps(tl))
            return run(d / f"{name}.json", None, d / name, 4)[0]

        if not export("clean", "fixed"):
            fails.append("a whole-viewport export failed")
        if export("zoomed", "zoom1.1"):
            fails.append("an export zoomed 1.1x for one second passed")
        if export("panned", "pan12"):
            fails.append("an export panned 12 px for one second passed")
        if not export("replayed", "fixed", back=True):
            fails.append("a shot that goes back in its take failed")
        tl = _media.Timeline(d / "clean.json")
        tl.shots.append(dict(tl.shots[0], view=[40, 20, 400, 250]))
        if not scale_errors(tl):
            fails.append("two shots at different scales passed the scale witness")
        _media.synth_take(d / "long.mp4", 160, 100, 60, 10)
        shot = {"take": str(d / "long.mp4"), "size": [160, 100], "view": [0, 0, 160, 100], "out0": 0, "out1": 60,
                "pieces": [[0, 60, 0, 60]]}
        tl = {"video": shot["take"], "fps": 10, "canvas": [160, 100], "shots": [shot]}
        (d / "long.json").write_text(json.dumps(tl))
        if not run(d / "long.json", None, d / "long", 2)[0]:
            fails.append("a 60 s export of its own take failed")
    print("framing.py self-test: " + ("PASS" if not fails else "FAIL\n  " + "\n  ".join(fails)))
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
