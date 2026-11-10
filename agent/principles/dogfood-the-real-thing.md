---
when: A change alters what a running app, CLI, or service does, once its tests are green or when it has no cheap test target.
---

# Dogfood the Real Thing

A green suite proves the code against its tests and fakes. Most bugs live where the code meets something real, such as an adapter's translation, an error shape, a timeout, or two events in an order nobody wrote a test for. Find those bugs by using the real thing, after the `tdd` skill's loop goes green, or in place of it when the change has no cheap test target.

1. **Drive it like a chaotic user.** Run the real app, CLI, or service with its real boundaries through the project's verification skill, a project-local skill such as `.pi/skills/verify-<app>/` that launches the app and drives its features. Cover every feature in its feature map that the change touches, then leave the happy path the way real users do. Try steps in the wrong order, a double submit, an interrupt or kill mid-operation, a restart, empty, huge, or malformed input, two sessions at once, and a slow or failing external service.
2. **Triage each bug against the base.** Run the same drive steps on the commit the change started from.
   - A bug the change caused gets fixed. Write the smallest test at a seam that reproduces it, run it red, fix the code, and run it green. When only the real boundary reproduces the bug, record the drive steps that do, and run them red before the fix and green after.
   - A bug the base has too is outside the change. Report it with its drive steps as a follow-up, and fix it only when the owner of the work adds it to the scope.
3. **Drive again after the fixes.** Dogfooding is done when a drive over the same features finds no new bug the change caused. When the time budget runs out first, stop and report each feature you did not reach as `not driven`. An inconclusive drive, or a drive of a surface the change does not reach, is not a pass.

When two fixes fail the same drive, or a third bug turns up at the same boundary, stop fixing. The design of that boundary is the suspect premise. Before the next fix, write that premise down and make the observation that would come out differently if it were false. When the redesign the evidence points to would change an agreed seam, a contract other work builds on, or an ADR, report the evidence to the owner of the work and stop there.

When the project has no verification skill, drive the real thing by hand. Run the real CLI, drive a web UI with the `agent-browser` skill, and send real requests to a running service. Then recommend the `create-verification-skill` skill in your report. When a drive shows that the verification skill's steps or feature map no longer match the app, report the drift and recommend the `maintain-verification-skill` skill.

## Check every order when order decides

When the behavior depends on the order of events, such as concurrency, retries, cancellation, or a lifecycle or state machine, each test and each drive samples one order.

- If a project-local skill model-checks or proves that code, follow it for this change.
- If none covers it, model the changed behavior with the `statechart` skill, so its model checker tries every order within the model's bounds. Replay each bug path it finds against the real code, as that skill requires, and triage each replayed bug against the base like a drive's bug. When the model checker cannot run, such as with no network for its first install, the check is `not run`, with the reason. Then recommend the `create-formal-verification-skill` skill in your report, so a model kept in the project covers the code after this change.
- When a formal check fails on code this change did not touch, the verification may be stale. Recommend the `maintain-formal-verification-skill` skill.

## Report the drive

Report the drive with the change:

- The features you drove, the off-path cases you tried, and each feature `not driven`, with the reason.
- Each bug the drive or a model check found, whether the base has it too, and its test, its drive steps, or its follow-up.
- Each model check you ran, its bounds, and its result.
- Each premise you attacked, and what the evidence showed.
- Each verification or formal verification skill you recommended, and the gap it would close.
