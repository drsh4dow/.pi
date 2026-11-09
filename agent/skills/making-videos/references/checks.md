# Checks on the export

Measure the file the viewer will watch, never the edit plan. Captions once "passed" against the plan while the export lagged, and a frame-rate filter scored the wrong frames, so every script picks frames by index. Get frames for your own eyes with `frames.py` (`--at`, `--around`, `--every`) rather than your own ffmpeg command: ffmpeg 8 dropped `-vsync`.

## One command

Run `scripts/check.sh FINAL.mp4 --timeline T` once per export. It runs every check below that applies, in parallel, and returns when the last one ends, so wait for its exit, not for its files. It writes `checks/verdict.txt` beside the export, with the export's sha256 on the first line and then one line per check with its status and, when it ran, its detail file. It exits 1 when any check fails. Pass `--profile captions` for a captions-only video with no voice. The default is `narrated`. The limits are the user's rules, fixed in each script, and no flag loosens them. Each script's `--help` gives them.

| Check                                                   | Script                               | Fails on                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dead air, quiet gaps, loudness, dark dips               | `check.sh` itself                    | a span over 1.0 s both frozen and silent; quiet over 0.5 s between lines or 0.6 s inside one, measured on the timeline's voice track (or `--voice`) once it matches the export, so a music bed cannot hide a pause; loudness outside -16 ±1 LUFS or a true peak above -1 dBTP; in a composed film, a frame more than 25% darker than the frames around it. |
| Caption holds and sync                                  | `sync.py`                            | a caption more than 0.3 s from its first spoken word; a caption that never shows, or a subtitle cue with other words; fewer than 80% of captions measured; with captions only, a caption up for less than 1.5 s plus 0.3 s per word. Speech starts come from the timeline's voice track (or `--voice`), and a voice the export does not carry fails.       |
| Whole picture, one scale                                | `framing.py`, recorded cuts          | a frame that a 1.1× zoom or an 8 px shift matches better; takes at different scales                                                                                                                                                                                                                                                                        |
| Overlay allowlist                                       | `overlays.py`, recorded cuts         | anything over the picture but rings and outlines; a self-test the detector misses                                                                                                                                                                                                                                                                          |
| Privacy OCR                                             | `check.sh` itself                    | only the OCR run erroring. Each distinct line read with `@`, `mail` or `.com` is a LOOK in `ocr.txt`, to compare by eye with the identities allowed on screen                                                                                                                                                                                              |
| Re-watch, with `--since EARLIER.mp4 [--allow T0-T1]...` | `check.sh` itself and `framediff.py` | nothing. It is a LOOK, and the watchers watch the whole export, when the decoded audio or the subtitle track differs from EARLIER's, or `framediff.py` finds a changed frame outside the spans, by the worst 8x8 patch, so a small email still shows                                                                                                       |

The dark-dip check runs on composed films only, where a dip is a fade the film drew. A recorded cut reports it not applicable, because a real dialog backdrop dims the page. A composed film has no `timeline.json`, so run `check.sh out/final.mp4 --timeline public/voice.json --caption-box 0,930,1920,150`, with the caption band so `sync.py` runs, and `--area` to measure dips on the stage only. Under a music bed, add `--voice public/voice.wav`.

## By eye

No script covers these, so look at full-size frames:

- Each claim against the frame that shows it. Synced captions once narrated dates the UI had not selected yet.
- Redaction from 0:00 on full-resolution frames, and the frame of each OCR hit in `ocr.txt`.
- Text size and how long each screen stays readable for this audience.
- Read the whole transcript once. Reused narration once repeated a line.
- Report the human listening pass as "not measured" and ask the user for one listen. Speech recognition checks words, not how they sound.
