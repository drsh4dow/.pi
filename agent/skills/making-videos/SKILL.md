---
name: making-videos
description: "Narrated videos end to end: brief, script, voice, capture of a web, Android or iOS app, composed motion graphics, cut, mix, and checks on the exported file. Use when the user asks for a video, walkthrough, demo, tutorial, promo, or recorded proof of a change."
disable-model-invocation: true
---

# Making videos

A video here is a script voiced first, a picture cued to that voice, one cut, and checks on the file the viewer will watch. Pick the blocks the video needs. The user's rules and the checks on the export apply to every video.

## The user's rules

Each rule cost the user at least one round of rework. A brief changes one only by naming it, and a brief you wrote changes none.

- **Real product, real data.** "I care more about the real product proof rather than the quality of the video itself." Record the real thing doing the work. Every fact the video states or draws traces to a file, a run, or a receipt in `CLAIMS.md`. Label what is staged or drawn. Use synthetic records only where a real one would expose a person.
- **The whole screen at one scale.** "the browser view should be complete, the full browser, not a zoom in that looks like shit." A web app is the full browser window, tabs and address bar included, at 1:1. A phone is its whole screen with the status and navigation bars, at one scale for the whole video. Words go outside the picture or in a subtitle track.
- **Voice first, live at 1.0×.** "also the pacing is awful." Voice the script, then drive or animate to the words, so each action lands as its line names it. The one edit to time is a jump cut over a real wait, with the measured time said or shown ("about 40 s later").
- **No weird pauses.** Quiet gaps of 0.12 to 0.5 s between lines and under 0.6 s inside one. Aim for something on screen to move at least every 2 s; a longer still is a should-fix, not a blocker. Speech runs about 150 to 175 words a minute, or up to 205 for ElevenLabs' Mark, whose pace cannot be changed. In a captions-only video, a caption stays up at least 1.5 s plus 0.3 s per word; a narrated caption lasts as long as its words.
- **Clear for this audience.** Name who watches, what they already know, and where it plays. For first-time viewers, say where each control is before using it, define each term in their words, and hold each new screen long enough to read before acting on it. Say what happens behind the screen, not only where to tap.
- **Looks are judged by eyes.** A structural checklist passed a video the user called "aesthetically a total failure". Show the user one finished chapter in its final framing before the full cut. Offer the look and the voice as separate picks, the voice as two or three rendered samples to hear.
- **A separate watcher before "ready".** "a subagent must also watch it before claim is ready to correct anything". A false or unshown claim blocks the cut. Polish never does: once both watchers say ready, every should-fix and nit goes to the user in the README.
- **One clear file, opened.** "where are the final videos? open its folder with xdg-open". See Handoff.

## Steps

Take these in order. Each ends on its done-when.

0. **Setup.** Run `scripts/check.sh --setup` with each picture kind the request names (`web`, `android`, `ios`, `compose`; see step 4). Done when it prints `setup: ready`, or its one line left is the voice key and the user chose captions only.
1. **Brief.** Write `BRIEF.md` in `~/Videos/<project>/src/`: the audience and what they know, where it plays, the one sentence they leave with, length, kind, truth sources, the identities allowed on screen, and the voice. Name the identities by pattern from the seed, such as every `<name>@example.com` it signs in, wherever they show, URLs and the status bar included. Each pattern matches only identities the seed created. Done when you have checked it against each rule above and nothing in it contradicts one.
2. **Script.** Write `script.json` and `CLAIMS.md` per [references/story.md](references/story.md). For a recorded app, check each line that says what the screen shows against the screen at the moment the line plays, from the state the take starts in, not only against the docs: two scripts voiced what the docs say while the screen showed otherwise, and each cost a watch round. Done when every line has its source in `CLAIMS.md`.
3. **Voice.** `scripts/narrate.py script.json` writes `narration.wav` and `voice.json`, the clock every later block reads. Render a chapter in two or three voices with `--voices` for the user to hear. The default is Gemini's Iapetus, then ElevenLabs' Mark, then captions only; say which one ran. When `narrate.py` prints more than 175 words a minute while speaking in a Gemini voice, slow it with `--style`, never by stretching its audio. Mark has no speed setting, so take his pace as it comes, up to 205, and do not add commas or split lines to slow him. A voice at 0.7, stretched again so each caption held 1.5 s, sounded to the user "like it is talking 0.5x"; that hold is for captions-only videos. Done when the user has picked the voice by ear (or you logged the default because the user said to run without stopping), and `narrate.py` reports a longest quiet gap of 0.5 s or less in that voice. A captions-only video runs `--voice captions` and has no voice to pick. Every take and scene is timed to this file, so a later voice change means new takes.
4. **Picture.** Read the reference for where the picture comes from:

   | Picture                                                     | Read                                                         |
   | ----------------------------------------------------------- | ------------------------------------------------------------ |
   | A web app in a browser                                      | [references/capture-web.md](references/capture-web.md)       |
   | An Android or iOS app                                       | [references/capture-mobile.md](references/capture-mobile.md) |
   | Motion graphics, a promo, an explainer, a terminal tutorial | [references/compose.md](references/compose.md)               |

   Re-take or re-cut before the watch only for what a watcher would rank a blocker: a false or unshown claim, a privacy break, or a failed check. A miss on another rule, such as a screen still for over 2 s, is a should-fix that step 8 leaves to the user.
   Done when you have looked at full-size frames of every take or scene yourself, and each logged click or tap lands on the frame where the UI reacts, measured on the take's clock.

5. **One chapter first.** Cut one chapter in its final framing, give the user its path, open it, and wait for a yes. If the user told you to run without stopping, log that you skipped the wait and show the chapter at handoff. Done on the user's yes or the logged skip.
6. **Cut and mix.** Per [references/cut-and-mix.md](references/cut-and-mix.md). Done when the export exists and you know its sha256.
7. **Check the export.** Run `scripts/check.sh` once per export, per [references/checks.md](references/checks.md), with `--since` on a re-cut. Done when `checks/verdict.txt` has no FAIL line and you have looked by eye at each LOOK hit and at what no script covers.
8. **Watch.** Brief two delegates with `instructionsFile: ~/.pi/agent/instructions/cold-reader.md` from [references/watcher-brief.md](references/watcher-brief.md) for each new sha256. Fix their blockers, re-export, run step 7 on the new export, and only then send it to two new watchers, with the re-watch block when [references/watcher-brief.md](references/watcher-brief.md) allows it. Change only the lines and shots a blocker names. A fixed line states only what its frame shows, and no other line gains a fact: one fix reworded four lines to clear one blocker, voiced a claim the picture never showed, and cost a third round. A fix to the brief alone, such as a seed identity it left out, leaves the export as it was, so only a new watcher for that part reviews it again. Stop when both say ready, and hand off that export with every should-fix and nit in the README for the user to pick: one polish re-cut cost 8.5 minutes, and another led to a second re-cut. Stop after three rounds otherwise: a cut with an open blocker is not a final, so tell the user which blockers are left.
9. **Hand off.** Done when the user has the path and the file is open.

## Handoff

- Put the absolute path of the final file on its own line, with its length and size, then open it with `xdg-open`.
- Finals go in `~/Videos/<project>/`, sources in `~/Videos/<project>/src/`. A disk cleanup once wiped every source of a video kept under `/tmp`.
- Write `README.md` beside the final with its path and sha256, length, chapters, how it was made (what is real, staged or masked), known gaps and the should-fixes and nits left for the user, both watcher verdicts with their sha256, and "human listening pass: not measured".
- Delete superseded cuts or mark them in the README. Give the user videos only, never an intermediate file such as a script or a timeline.
- For a PR or ticket, upload the file (the **dumpfile** skill, or the tracker's own upload), download it again, compare sha256, and link the URL.

## Machine

- Run one render or recording at a time, in the background. Video work has run this machine out of memory.
- Stop every recorder, browser and emulator you start in a `finally`, and leave shared ones alone.
- Before helpers start from a brief, run each command in it once. A wrong render flag in one brief made three helpers render the whole film.

## Scripts

All in `scripts/`. Each prints `--help`, takes parameters, and has a self-test; `scripts/self-test` runs them all. Run each as an executable so its `uv run --quiet --script` shebang installs what it declares. The tools they need are in [references/setup.md](references/setup.md).

| Script                                                                   | Block                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `narrate.py`, `tts.py`                                                   | voice: lines to `narration.wav` and `voice.json`, cached per line              |
| `window.py`, `drive.py`, `cdp.mjs`, `mask.js`                            | web capture: full window on Xvfb, human input, events log, privacy mask        |
| `cut.py`                                                                 | cut takes from `EDIT.json`: one scale, rings, outlines, captions, chips, voice |
| `mix.sh`, `music.sh`                                                     | voice plus an optional music bed, ducked, to -16 LUFS                          |
| `check.sh` (runs `sync.py`, `framing.py`, `overlays.py`, `framediff.py`) | checks on the export; `--setup` checks the machine first                       |
| `frames.py`                                                              | frames by index for your eyes and the watchers'                                |

`templates/remotion/` is the starter for composed films.
