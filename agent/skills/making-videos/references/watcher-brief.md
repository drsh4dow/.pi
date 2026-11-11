# Watcher brief

Fill the brackets and send the block as the task message of two delegates with `instructionsFile: ~/.pi/agent/instructions/cold-reader.md`, one with the privacy part and one with the story part. Start both, then group them, so they watch at once. A new sha256 gets two new delegates. Each returns its findings as its answer; save them beside the export as `<export name>.privacy.md` and `<export name>.story.md`.

```text
You are a watcher. Review one video export cold. Do not edit the video or its sources.
Your part: [privacy: steps 1 and 2 | story: steps 1, 3, 4 and 5]. Another watcher does the other steps; skip them.

Export: [absolute path], sha256 [hash]. Kind: [walkthrough | demo | tutorial | promo | proof clip | explainer].
Pick frames by index with [skill dir]/scripts/frames.py and open them with the read tool.
Clock: [voice.json]. Timeline: [timeline.json, or "composed film"]. Transcript: [transcript.md, or the say lines of script.json for a composed film].
Claims: [CLAIMS.md: each line's claim and the source or receipt that backs it].
Audience: [who watches, what they already know, where it plays]. Identities allowed on screen: [list].
Author's verdict: [absolute path of checks/verdict.txt].

1. Quote each line of the author's verdict.txt. Do not run check.sh. A missing verdict, a first line whose
   sha256 is not what sha256sum prints for the export, or any FAIL line is a blocker.
2. Check redaction on full-resolution frames, starting at 0:00, and the frame of each hit in the ocr.txt beside
   the verdict.txt you quoted, against the identities allowed on screen. Stop at the first frame that shows
   [data that may never appear, such as client or health data], report its time and what it shows, and review
   nothing further.
3. Look at every cut, every caption change near a cut, the frame where each narrated action happens, and the
   frame where each result appears. For every claim, find the frame that shows it and the source that backs
   it. A claim the picture does not show, shows only later, or contradicts is a blocker. So is a control the
   voice says worked that did not.
4. Watch as the audience. Then explain back, in their words, what the video taught and what you would do
   next. Each step you could not explain, and each screen still for over 2 s, is a should-fix.
5. Report on-screen noise in the product (stray hints, clipped text, odd states) as product feedback.

Rank each finding: blocker (a false or unshown claim, where shown means on screen long enough and large
enough to read at watch size; a privacy break; a failed check), should-fix (shown but
hard to follow), nit (polish). A story watcher notes a frame it doubts for privacy and leaves it out of its
verdict, since the privacy watcher rules on it. Give each its time, frame number, what is wrong and the
evidence. End with `ready for sha256 [hash]`, or `not ready for sha256 [hash]` when you found a blocker.
Should-fixes and nits alone mean ready.
```

**Re-watch.** A re-cut gets the block above plus the one below when both earlier watchers covered their whole parts and no change adds a claim. Otherwise it gets the block above alone. Cut and export each fix to a new path, so the earlier export is still there, and run `scripts/check.sh` on it (SKILL.md step 7) with `--since [earlier export]` and one `--allow T0-T1` per changed span.

```text
Earlier export: [absolute path], sha256 [earlier hash], findings [its .privacy.md and .story.md].
Changed spans: [each T0-T1 span, and the earlier finding it fixes].

Do step 1 as written. Its re-watch line must PASS on [earlier hash], and both earlier findings must end on that
hash. If not, or if a span shows a claim the earlier findings did not check, do your part's steps on the whole
export.

Otherwise, check at its frame that each earlier finding of your part listed as fixed is resolved. The privacy
watcher checks every ocr.txt hit wherever it falls and does step 2 inside the changed spans. The story watcher
does step 4 on the whole video and steps 3 and 5 inside the changed spans. Carry your part's earlier findings for everything outside
the spans into your report.
```

A cut is ready only when both watchers say ready for its sha256. The user is not the fallback reviewer.
