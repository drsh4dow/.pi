---
when: Any non-trivial work, such as edits, migrations, or analyses, where a codemod, script, or generator could do the work or prove it.
---

# Build the Lever

When the work isn't trivial, build the tool that does it instead of doing it by hand.

A codemod, generator, or script does the work the same way every time and reruns for free. The tool is one artifact a reviewer can read and rerun to check the work. Hand-done changes can only be re-verified by redoing them. A deterministic script turns "trust me" into "run this".

Default to building the lever. Skip it only when the task is trivial, a couple of obvious edits you can see at a glance.

- Do the first unit by hand to learn the recipe, then build the tool. Prove it by rerunning it on that unit and diffing against your hand-done version. Make the lever safe to rerun.
- Use a codemod or script for edits, a generator for repetitive files, and a dump-to-sqlite query for analysis.
- A deterministic lever beats fan-out. If the tool can process every unit in one pass, run it yourself. Don't start delegates to hand-apply what a script can do.
- When you split work across delegates, write the lever as one file they all read, holding the recipe, the verification contract, and the do-not-touch fences. Keep it outside the delegates' write scope so they can't quietly edit the contract.
- Applying this principle produces a file. If you cited it and there is no codemod, script, generator, or shared delegate recipe in the diff, you didn't apply it.
- Commit the lever when the work outlives the session.

The bar is triviality, not repetition. A one-off still earns a lever when the lever is what makes the work checkable. Build the smallest script that does or proves the job, never a framework.
