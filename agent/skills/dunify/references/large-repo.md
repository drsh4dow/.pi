# Large repos

The dunify reference for an existing repo that step 1 of [`../SKILL.md`](../SKILL.md) measures as too large for one agent. It changes steps 1 to 7 and adds one stage before step 8.

A **slice** is one build module or package, the unit that moves on one branch. An **area** is a group of slices that one delegate can search, up to about 50,000 lines of source. A larger slice is an area of its own. Cut both along the build tool's own modules. Group slices into areas by name prefix, and keep a slice with the slices it imports most.

You keep the measure, the layout map, the shared files and every stop with the user. Delegates read the code and move it.

## Step 1. Read by area

Start one leaf delegate per area, all in one group. Give each its area's paths and measured numbers, the list with paths from step 1 of `SKILL.md`, and three more items:

- each import that leaves the area and each module outside it that imports from it;
- for each slice, the narrowest build and test command that covers it, named and not run;
- each mistake that the area's history shows fixed twice.

Tell each to find its answers by search, to read only what a hit points to, and to answer under the list's own headings with one line and one path per finding. Build the repo's list from their answers. Open a file yourself only where two answers disagree.

Done when every area has answered, and the code that issues each durable value's writes is named.

## Step 2. Plan the slices

Draw the rows for each runtime directory and each contract edge in full. Give each slice one row. A slice's inner rows wait for its own run. Source that the build leaves out gets a row with the user's choices, which are to delete it or to bring it into the build.

Under the map, add the **slice plan**. Each line names one slice, its lines of source, its commits of the last 90 days, the slices it imports, the slices that import it, and its build and test command. A move changes the import lines of every importer, so order the plan by fewest importers first.

Put the **pilot** first. The pilot is a slice of a few thousand lines with at most one importer and few recent commits. It writes a durable value, and it crosses a contract edge where the repo has one, so it meets every gate. Draw its inner rows in full.

Say how many slices this run covers. Propose the pilot and a few more with at most one importer each. Every other slice goes on the cleanup plan in the plan's order.

Done when the user approves the map, the bans, the slice plan and the count.

## Steps 3 to 7. Run the pilot

Run these steps yourself, with three changes:

- In step 3, move the pilot's files only.
- In step 6, run auto-fix on the pilot only, and record the baseline for the whole repo.
- In step 7, `check` runs on the whole repo.

Where the pilot shows a row of the map wrong, change the row and get the change approved before another slice moves.

Done when `check` exits 0 on the whole repo with the pilot moved.

## Before step 8. Run the remaining slices

Hand each remaining slice of this run to one owner delegate, in its own worktree, on a branch cut from the last accepted one. Start together only slices with no import between them and no importer in common.

Give each owner:

- its slice's row, and the pilot's rows and commits as the pattern to copy;
- the language reference and the `check` command;
- its slice's build and test command, to run on the untouched slice first and after each move;
- what done means. The slice's inner rows are drawn. Every file is moved to its row or named as mixing two rows. Auto-fix has run on the slice. Each moved file's baseline counts moved with it, and none rose. `check` exits 0, and the work is committed.

The ledger, the gate rules, the `check` command and `CODING_STANDARDS.md` are yours alone. An owner edits its slice's files and its slice's baseline counts. Outside its slice it changes only the lines that name a moved file, in the importers and in the build's module list, with one scripted rewrite. It reports any other change it needs in its answer.

An owner's answer is a claim. Read its diff and run `check` on its branch. Show the user each row for a noun of the project's own before you accept the slice. Accept slices in the plan's order, and rebase each accepted branch onto the one before it.

Done when `check` exits 0 on the tip that holds every accepted slice. In step 8, the cleanup plan lists each slice not run, in the plan's order.
