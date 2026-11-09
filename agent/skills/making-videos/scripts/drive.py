#!/usr/bin/env python3
"""Human-paced agent-browser driver for recording takes, with every action logged on the recording's clock.

As a module, from a take script of your own (stdlib only):

    sys.path.insert(0, "<skill dir>/scripts"); from drive import Take
    t = Take("t1-save", session="walk", out_dir="takes", width=1440, height=900, mask_js="<skill dir>/scripts/mask.js")
    t.state("start", note_length=812)            # the state this take starts from (provenance)
    t.start()                                    # viewport, mask, record start --cursor; the clock starts here
                                                 # (or `with t:` ... so a failing step still stops the recorder)
    t.mark_box("save", t.by_text("button", "Save"))   # a DOM box the edit can outline later
    t.click(t.by_text("button", "Save"), "Save")
    t.wait_until("document.body.innerText.includes('Saved')", "save lands")   # a wait the edit can jump-cut
    t.wrote("note", action_id="<receipt id>")    # a write this take made, with the receipt it owns
    t.stop()                                     # writes takes/t1-save.mp4 and takes/t1-save.events.json

A take cued to the voice fires each action on its word, by cut.py's "Timing a take to the voice" rule:

    t.cue("voice/voice.json", chapter="today", lead=1.0)
    with t:
        t.mark_box("strip", "document.querySelector('h1')", t.by_text("p", "Spend"))
        t.hover(t.by_text("p", "Spend"), "spend", on=t.word("t3", "spend"))
        t.click(t.by_text("a", "Cal"), "Cal", on=t.word("t7", "table", nth=1))
        t.wait_until("location.pathname.startsWith('/cal')", "Cal's page", jump_cut=True)
        t.at(t.word("t8", "below"))
        t.scroll(400, "down")
        t.at(t.line_end("t9") + 1)

    t.word(line, w, nth=0)  voice.json time of the nth w in that line, matched without case or punctuation
    t.line_end(line)        voice.json time that line ends
    t.at(voice_t)           sleep until that voice time; log "late" when the take is past it by more than LATE_S
    t.take_t(voice_t)       the take second a voice time lands on, counting the jump cuts so far, so call it where
                            the action is; it gives an outline's "src" in EDIT.json
    move, hover, click      with on=voice_t, the pointer arrives or the button goes down then; hover and click look
                            up the box LOOKUP_S before the word, so a slow lookup is not late. They aim at the
                            element's text, or its box when it has none. on= is for pointer actions;
                            t.at(voice_t) cues everything else
    mark_box(label, *js)    one box around all the elements
    wait_until(jump_cut=True)   a wait the shot jump-cuts, so later cued actions fire that much later in the take

CLI:
    drive.py preflight --session S --out DIR [--width 1440 --height 900]   # 2 s test take: is the window painting?
    drive.py --self-test

page_match: the URL substring of the tab that wheel scrolls go to. Empty means this session's current tab URL.

events.json: {"take", "width", "height", "fps", "recorded_at" (UTC), "events": [{"t", "kind", ...}],
"provenance": {"states", "writes"}}. t is seconds since `record start`. Logs hold coordinates, labels, lengths
and IDs, never typed text. Pointer moves are eased (--human) and take 120-900 ms; typing is per character,
35-90 ms apart; scrolls are real wheel events at the pointer (cdp.mjs wheel). One take records one tab: the
recorder follows the active tab, so a second tab is its own take.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import random
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
LATE_S = 0.15
LOOKUP_S = 1.5  # the longest move, the settle before the press, and a slow eval
SETTLE_S = 0.12


def window_starts(voice: dict) -> dict[str, float]:
    """Each chapter's window start on voice.json's clock, halfway through the quiet before it, or 0 for the first."""
    chs = voice["chapters"]
    return {c["id"]: 0.0 if i == 0 else (chs[i - 1]["end"] + c["start"]) / 2 for i, c in enumerate(chs)}


def run_ab(args: list[str], timeout: float = 120) -> subprocess.CompletedProcess:
    return subprocess.run(["agent-browser", *args], capture_output=True, text=True, timeout=timeout)


class Take:
    def __init__(self, name: str, session: str, out_dir, width: int = 1440, height: int = 900, fps: int = 30,
                 mask_js=None, mask_terms: list[str] | None = None, page_match: str = "", runner=run_ab):
        self.name, self.session, self.out = name, session, Path(out_dir)
        self.width, self.height, self.fps = width, height, fps
        self.mask_js, self.mask_terms, self.page_match = mask_js, mask_terms or [], page_match
        self.runner = runner
        self.events: list[dict] = []
        self.states: list[dict] = []
        self.writes: list[dict] = []
        self.t0: float | None = None
        self.recorded_at: str | None = None
        self.mouse = (width // 2, height // 2)
        self.rng = random.Random(name)
        self.lines: dict[str, dict] = {}
        self.shift = self.jumped = 0.0

    # ---- plumbing -------------------------------------------------------
    def ab(self, *args: str, check: bool = True) -> str:
        r = self.runner(["--session", self.session, *args])
        if check and r.returncode != 0:
            raise RuntimeError(f"agent-browser {' '.join(args[:2])} failed: {r.stderr[-300:]}")
        return r.stdout.strip()

    def js(self, code: str):
        out = self.ab("eval", code)
        try:
            v = json.loads(out)
            return json.loads(v) if isinstance(v, str) and v[:1] in "{[" else v
        except json.JSONDecodeError:
            return out

    def now(self) -> float:
        return 0.0 if self.t0 is None else round(time.time() - self.t0, 3)

    def log(self, kind: str, **kw) -> dict:
        ev = {"t": self.now(), "kind": kind, **kw}
        self.events.append(ev)
        print(json.dumps(ev), file=sys.stderr, flush=True)
        return ev

    def save(self) -> Path:
        self.out.mkdir(parents=True, exist_ok=True)
        p = self.out / f"{self.name}.events.json"
        p.write_text(json.dumps({"take": self.name, "width": self.width, "height": self.height, "fps": self.fps,
                                 "recorded_at": self.recorded_at, "events": self.events,
                                 "provenance": {"states": self.states, "writes": self.writes}}, indent=1))
        return p

    # ---- provenance -------------------------------------------------------
    def state(self, label: str, **facts) -> None:
        """A fact about the product state (IDs, counts, lengths, times), before, during or after the take."""
        self.states.append(self.log("state", label=label, **facts))

    def wrote(self, what: str, **receipt) -> None:
        """A write this take made, with the receipt (action ID, row ID) it owns."""
        self.writes.append(self.log("write", what=what, **receipt))

    # ---- recording ------------------------------------------------------
    def start(self) -> None:
        self.ab("set", "viewport", str(self.width), str(self.height))
        if self.mask_terms:
            self.ab("eval", f"window.__uiwMaskTerms={json.dumps(self.mask_terms)}")
        if self.mask_js:
            self.ab("eval", Path(self.mask_js).read_text())
        time.sleep(0.3)
        self.out.mkdir(parents=True, exist_ok=True)
        self.ab("record", "start", str((self.out / f"{self.name}.mp4").resolve()), "--cursor", "--fps", str(self.fps))
        self.t0 = time.time()
        self.recorded_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        self.log("record_start")
        self.glide(*self.mouse, 200)

    def stop(self) -> Path:
        self.log("record_stop")
        self.ab("record", "stop")
        return self.save()

    def __enter__(self) -> "Take":
        self.start()
        return self

    def __exit__(self, kind, err, tb) -> None:
        """Stop the recorder and keep the log even when a step fails, so a failed take never records on."""
        if kind:
            self.log("aborted", error=kind.__name__)
        self.stop()

    def pause(self, sec: float) -> None:
        time.sleep(sec)

    def mark(self, label: str, **kw) -> None:
        self.log("mark", label=label, **kw)

    def mark_box(self, label: str, *js_exprs: str) -> dict:
        """One box around every element, logged as a mark that cut.py outlines can name."""
        bs = [self.box(e) for e in js_exprs]
        x0, y0 = min(b["x"] for b in bs), min(b["y"] for b in bs)
        x1, y1 = max(b["x"] + b["w"] for b in bs), max(b["y"] + b["h"] for b in bs)
        b = {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}
        self.mark(label, box=b)
        return b

    def cue(self, voice, chapter: str, lead: float = 1.0) -> None:
        """Time this take to voice.json, so that chapter's window starts at take second lead."""
        v = json.loads(Path(voice).read_text())
        self.lines = {ln["id"]: ln for ln in v["lines"]}
        self.shift = lead - window_starts(v)[chapter]

    def word(self, line: str, w: str, nth: int = 0) -> float:
        norm = lambda s: re.sub(r"\W", "", s.lower())  # noqa: E731
        hits = [x["t"] for x in self.lines[line]["words"] if norm(x["w"]) == norm(w)]
        if len(hits) <= nth:
            raise KeyError(f"{w!r} #{nth} not in line {line}: {[x['w'] for x in self.lines[line]['words']]}")
        return hits[nth]

    def line_end(self, line: str) -> float:
        return self.lines[line]["end"]

    def take_t(self, voice_t: float) -> float:
        return voice_t + self.shift + self.jumped

    def at(self, voice_t: float | None, early: float = 0.0) -> None:
        if voice_t is None:
            return
        d = self.take_t(voice_t) - early - self.now()
        if d > 0:
            time.sleep(d)
        elif d < -LATE_S:
            self.log("late", voice_t=voice_t, by=round(-d, 3))

    def aim(self, js_expr: str, fx: float, fy: float, on: float | None) -> tuple[dict, float, float]:
        if on is not None:
            time.sleep(max(0.0, self.take_t(on) - LOOKUP_S - self.now()))
        b = self.box(js_expr, text=True)
        return b, b["x"] + b["w"] * fx, b["y"] + b["h"] * fy

    # ---- geometry -------------------------------------------------------
    def box(self, js_expr: str, text: bool = False) -> dict:
        """js_expr evaluates to an Element; returns its viewport box in CSS px. With text=True it returns the part
        of that box its text covers, or the whole box when its text covers none of it."""
        g = ("const o=e.getBoundingClientRect(), g=document.createRange(); g.selectNodeContents(e);"
             "const t=g.getBoundingClientRect(), x=Math.max(t.left,o.left), y=Math.max(t.top,o.top),"
             "w=Math.min(t.right,o.right)-x, h=Math.min(t.bottom,o.bottom)-y;"
             "const r=w>0&&h>0?{x,y,width:w,height:h}:o;") if text else "const r=e.getBoundingClientRect();"
        b = self.js(f"((e)=>{{if(!e) return null; {g}return JSON.stringify({{x:r.x,y:r.y,w:r.width,h:r.height}})}})"
                    f"({js_expr})")
        if not b:
            raise RuntimeError(f"no element for {js_expr[:80]}")
        return b

    @staticmethod
    def by_text(tag: str, text: str, exact: bool = True) -> str:
        t = json.dumps(text)
        cond = f"e.textContent.trim()==={t}" if exact else f"e.textContent.includes({t})"
        return f"[...document.querySelectorAll({json.dumps(tag)})].find(e=>{cond})"

    # ---- pointer ----------------------------------------------------------
    def move(self, x: float, y: float, dur: int | None = None, on: float | None = None) -> None:
        """An eased move that arrives at voice time on, when given."""
        x, y = int(x), int(y)
        dist = math.hypot(x - self.mouse[0], y - self.mouse[1])
        if dist < 2:
            self.at(on)
            return
        dur = dur or int(min(900, max(280 if dist > 60 else 120, dist * 0.9)))
        self.at(on, early=dur / 1000)
        self.glide(x, y, dur)
        self.mouse = (x, y)

    def glide(self, x: int, y: int, dur: int) -> None:
        self.ab("mouse", "move", str(x), str(y), "--human", "--duration", str(dur), "--steps", str(max(8, dur // 16)),
                "--seed", str(self.rng.randint(1, 9999)))

    def click_xy(self, x: float, y: float, label: str, hold: float = 0.08, on: float | None = None) -> None:
        self.move(x, y, on=None if on is None else on - SETTLE_S)
        time.sleep(SETTLE_S)
        self.log("click", x=int(x), y=int(y), label=label)
        self.press_button(hold)

    def press_button(self, hold: float) -> None:
        self.ab("mouse", "down")
        time.sleep(hold)
        self.ab("mouse", "up")

    def click(self, js_expr: str, label: str, fx: float = 0.5, fy: float = 0.5, on: float | None = None) -> dict:
        b, x, y = self.aim(js_expr, fx, fy, on)
        self.click_xy(x, y, label, on=on)
        return b

    def hover(self, js_expr: str, label: str, fx: float = 0.5, fy: float = 0.5, on: float | None = None) -> dict:
        b, x, y = self.aim(js_expr, fx, fy, on)
        self.move(x, y, on=on)
        self.log("hover", label=label, **{k: int(v) for k, v in b.items()})
        return b

    def drag(self, x0, y0, x1, y1, label: str, dur: int = 700) -> None:
        self.move(x0, y0)
        time.sleep(0.15)
        self.log("drag", x=int(x0), y=int(y0), x1=int(x1), y1=int(y1), label=label)
        self.ab("mouse", "down")
        self.move(x1, y1, dur=dur)
        time.sleep(0.1)
        self.ab("mouse", "up")

    def wheel_target(self) -> str:
        """The URL substring cdp.mjs wheel matches: page_match, else this session's own tab. An empty match would
        pick the browser's first tab, which in a shared browser is often another agent's."""
        match = self.page_match or self.ab("get", "url")
        if not match:
            raise RuntimeError("no page to wheel: set page_match or open a page in this session first")
        return match

    def wheel(self, dy: int, steps: int) -> None:
        ws = self.ab("get", "cdp-url")
        r = subprocess.run(["node", str(HERE / "cdp.mjs"), "wheel", "--ws", ws, "--match", self.wheel_target(),
                            "--x", str(self.mouse[0]), "--y", str(self.mouse[1]), "--dy", str(dy), "--steps", str(steps)],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            raise RuntimeError(r.stderr[-300:])

    def scroll(self, dy: int, label: str = "scroll") -> None:
        self.log("scroll", dy=dy, label=label)
        self.wheel(dy, max(12, abs(dy) // 20))
        time.sleep(0.3)

    def scroll_to(self, js_expr: str, target_y: float = 200, label: str = "scroll") -> None:
        b = self.box(js_expr)
        if abs(b["y"] - target_y) > 20:
            self.scroll(int(b["y"] - target_y), label=label)

    # ---- keyboard ---------------------------------------------------------
    def type(self, text: str, label: str) -> None:
        self.log("type_start", label=label, chars=len(text))
        for ch in text:
            self.ab("press", "Enter") if ch == "\n" else self.ab("keyboard", "type", ch)
            time.sleep(self.rng.uniform(0.035, 0.09))
        self.log("type_end", label=label)

    def press(self, key: str, label: str | None = None) -> None:
        self.log("key", key=key, label=label or key)
        self.ab("press", key)

    def paste(self, text: str, label: str) -> None:
        self.log("paste", label=label, chars=len(text))
        self.ab("keyboard", "inserttext", text)

    # ---- waits (logged so the edit can jump-cut them) ------------------------
    def wait_until(self, js_cond: str, label: str, timeout: float = 120, every: float = 0.2,
                   jump_cut: bool = False) -> float:
        t0 = self.log("wait_start", label=label)["t"]
        start = time.time()
        while time.time() - start < timeout:
            if self.js(f"(()=>{{try{{return !!({js_cond})}}catch(e){{return false}}}})()") is True:
                took = round(time.time() - start, 1)
                t1 = self.log("wait_end", label=label, took=took)["t"]
                if jump_cut:
                    self.jumped += t1 - t0
                return took
            time.sleep(every)
        self.log("wait_timeout", label=label)
        raise TimeoutError(label)


def frame_count(printed: str) -> int:
    """ffprobe's nb_read_frames as csv: ffprobe 9 prints "43," where older ones print "43"."""
    return int((re.findall(r"\d+", printed) or ["0"])[0])


def preflight(session: str, out: Path, width: int, height: int) -> int:
    """Record 2 s while moving the pointer; fail when the window is not painting."""
    t = Take("preflight", session, out, width, height)
    try:
        t.start()
        t.move(width * 0.25, height * 0.3)
        t.move(width * 0.75, height * 0.7)
        t.stop()
    except (RuntimeError, subprocess.TimeoutExpired) as e:
        print(f"preflight: FAIL, {type(e).__name__}: {str(e)[-200:]}\n  A pointer move that times out means the window"
              " is not painting (minimised or hidden). Open a new window with `cdp.mjs new-window`, attach there"
              " (agent-browser --session S connect <port>, then switch to its tab), and close only its tabs after.")
        return 1
    mp4 = out / "preflight.mp4"
    frames = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                             "stream=nb_read_frames", "-of", "csv=p=0", str(mp4)], capture_output=True, text=True).stdout.strip()
    frozen = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(mp4), "-vf", "freezedetect=n=-60dB:d=1.5",
                             "-f", "null", "-"], capture_output=True, text=True).stderr
    n = frame_count(frames)
    ok = n >= 15 and "freeze_start" not in frozen
    print(f"preflight: {'PASS' if ok else 'FAIL'}, {n} frames, pointer motion {'seen' if 'freeze_start' not in frozen else 'NOT seen'}"
          f" in {mp4}")
    return 0 if ok else 1


def self_test() -> int:
    import tempfile

    fails, calls = [], []

    class R:
        def __init__(self, out="", code=0):
            self.stdout, self.returncode, self.stderr = out, code, ""

    def fake(args):
        calls.append(args[2:])
        if args[2] == "eval" and "getBoundingClientRect" in args[3]:
            return R(json.dumps(json.dumps({"x": 100, "y": 40, "w": 80, "h": 20})))
        if args[2] == "eval" and "!!(" in args[3]:
            return R("true")
        return R()

    with tempfile.TemporaryDirectory() as tmp:
        t = Take("t1", "s", tmp, 800, 600, mask_js=HERE / "mask.js", mask_terms=["A Name"], runner=fake)
        t.wheel = lambda dy, steps: calls.append(["wheel", dy, steps])
        t.state("start", rows=3)
        t.start()
        t.mark_box("save", t.by_text("button", "Save"))
        t.click(t.by_text("button", "Save"), "Save")
        t.type("secret words", "note")
        t.scroll(400)
        t.wait_until("1", "lands")
        t.wrote("note", action_id="synthetic-1")
        p = t.stop()
        ev = json.loads(p.read_text())
        kinds = [e["kind"] for e in ev["events"]]
        want = ["state", "record_start", "mark", "click", "type_start", "type_end", "scroll", "wait_start", "wait_end",
                "write", "record_stop"]
        if kinds != want:
            fails.append(f"event kinds {kinds}")
        if "secret" in p.read_text():
            fails.append("typed text reached the events log")
        click = next(e for e in ev["events"] if e["kind"] == "click")
        if (click["x"], click["y"]) != (140, 50):
            fails.append(f"click at {click['x']},{click['y']}, want the box centre 140,50")
        if ev["provenance"]["writes"][0]["action_id"] != "synthetic-1" or ev["provenance"]["states"][0]["rows"] != 3:
            fails.append(f"provenance {ev['provenance']}")
        order = [c[0] for c in calls]
        i_vp, i_rec = order.index("set"), order.index("record")
        evals = [i for i, c in enumerate(calls) if c[0] == "eval" and "uiw" in " ".join(map(str, c))]
        if not (i_vp < min(evals) and max(evals) < i_rec):
            fails.append("viewport and mask must come before record start")
        rec = calls[i_rec]
        if rec[:2] != ["record", "start"] or "--cursor" not in rec or rec[rec.index("--fps") + 1] != "30":
            fails.append(f"record start args {rec}")
        times = [e["t"] for e in ev["events"]]
        if times != sorted(times):
            fails.append("event times go backwards")
        if ["wheel", 400, 20] not in calls:
            fails.append("scroll did not wheel at the pointer")

    polls = []

    def fake_paced(args):
        if args[2:4] == ["mouse", "move"]:
            time.sleep(int(args[args.index("--duration") + 1]) / 1000)
        if args[2] == "eval" and "#b" in args[3]:
            time.sleep(0.4)
            return R(json.dumps(json.dumps({"x": 300, "y": 200, "w": 50, "h": 10})))
        if args[2] == "eval" and "!!(lands" in args[3]:
            polls.append(1)
            return R("true" if len(polls) > 2 else "false")
        return fake(args)

    with tempfile.TemporaryDirectory() as tmp:
        voice = Path(tmp) / "voice.json"
        voice.write_text(json.dumps({"chapters": [{"id": "c1", "start": 0.3, "end": 2.0}, {"id": "c2", "start": 2.4, "end": 5}],
                                     "lines": [{"id": "b1", "end": 3.6, "words": [{"w": "Save,", "t": 2.5}, {"w": "it", "t": 2.7},
                                                                                {"w": "SAVE!", "t": 3.4}]}]}))
        t = Take("cued", "s", tmp, 800, 600, runner=fake_paced)
        t.wheel = lambda dy, steps: None
        lead, window_start = 0.3, (2.0 + 2.4) / 2
        t.cue(voice, chapter="c2", lead=lead)
        with t:
            t.hover("#a", "a", on=t.word("b1", "save"))
            t.click("#b", "b", on=t.word("b1", "save", nth=1))
            t.wait_until("lands", "lands", every=0.1, jump_cut=True)
            t.at(t.line_end("b1"))
            t.scroll(100)
            t.at(t.word("b1", "it"))
            both = t.mark_box("both", "#a", "#b")
        ev = {e["kind"]: e for e in t.events}
        jump = ev["wait_end"]["t"] - ev["wait_start"]["t"]
        for kind, want in (("hover", lead + 2.5 - window_start), ("click", lead + 3.4 - window_start),
                           ("scroll", lead + 3.6 - window_start + jump)):
            if abs(ev[kind]["t"] - want) > 0.05:
                fails.append(f"cued {kind} at take {ev[kind]['t']} s, want {want:.2f} (lead + word - window start + jumps)")
        if jump < 0.15:
            fails.append(f"the jump-cut wait took {jump} s, too short to prove the scroll moved by it")
        if ev.get("late", {}).get("voice_t") != 2.7:
            fails.append(f"an action past its word logged no late event: {ev.get('late')}")
        if both != {"x": 100, "y": 40, "w": 250, "h": 170}:
            fails.append(f"mark_box of two elements gave {both}, want the box around both")

    def fake_url(args):
        return R("https://app.example.test/mine\n") if args[2:4] == ["get", "url"] else R()

    with tempfile.TemporaryDirectory() as tmp:
        if Take("t2", "s", tmp, runner=fake_url).wheel_target() != "https://app.example.test/mine":
            fails.append("an empty page_match did not default to the session's own tab")
        if Take("t3", "s", tmp, page_match="other", runner=fake_url).wheel_target() != "other":
            fails.append("page_match was ignored")
        try:
            Take("t4", "s", tmp, runner=lambda a: R()).wheel_target()
            fails.append("a session with no page and no page_match was allowed to wheel")
        except RuntimeError:
            pass
    for printed, want in (("43,", 43), ("43", 43), ("", 0)):
        got = frame_count(printed)
        if got != want:
            fails.append(f"ffprobe frame count {printed!r} parsed as {got}, want {want}")
    print("drive.py self-test: " + ("PASS" if not fails else "FAIL\n  " + "\n  ".join(fails)))
    return 0 if not fails else 1


def main() -> int:
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if a[0] == "--self-test":
        return self_test()
    if a[0] == "preflight":
        g = lambda k, d=None: a[a.index(k) + 1] if k in a else d  # noqa: E731
        return preflight(g("--session"), Path(g("--out", ".")), int(g("--width", 1440)), int(g("--height", 900)))
    print(f"drive.py: unknown command {a[0]}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
