---
name: writing-good-prs
description: Opening a PR, editing a live PR's title or body, or posting or editing its evidence comment.
disable-model-invocation: false
---

# Writing good PRs

A PR has two readers. The reviewer reads the body as a one-minute briefing before the diff: why the change exists, what changed, what it leaves out, what it could break, and how you proved it works. The body follows the Descriptions rules in [references/pr-descriptions.md](references/pr-descriptions.md). The second reader is an expert in the field who must own the change after it merges. What they need beyond the briefing goes in one evidence comment that the body links.

The test: from the body and the evidence comment alone, without cloning the branch, that expert can retell the problem and the reason for the fix, and finds every question they would ask about the proof answered.

Write as one engineer explains a change to another, in short, simple sentences with few identifiers and only terms the reader would not stop to ask about. Edit it with the **technical-writing** skill, every layer except Diátaxis and with its STE vocabulary rules, then with the **unslop** skill. When the repository has a PR template, fill its sections and apply the rules below to the section that plays each role.

## Title

Follow the subject rules of **writing-good-commits**: `type(scope): subject`, imperative, completing "If merged, this PR will …", within 72 characters. Name the one change the PR makes, bounded by what Verification proves. A title that promises "no process outlives its launcher" fails when Blast Radius names a process that still does.

## Body

```markdown
## Why

## What changed

## Scope

## Tradeoffs

## Blast Radius

## Verification
```

Start at `## Why` with no preamble, and end with no footer or attribution line, such as "Generated with". Drop `## What changed` or `## Tradeoffs` when it has nothing to say. Keep the body within 40 lines.

Write for a reader who has only the base branch, this diff, and the tickets the PR links, and describe the change as it stands at this PR's head. How the work was produced, such as the earlier PRs that built it, the branches it passed through, who verified it, and the review rounds, belongs in the commit list and on the tickets. Name another PR only when this one needs it to merge, deploy, or make sense, by its number and with what it does.

Everything the body and the evidence comment point at is reachable by any developer with access to the repository: files linked on the default branch, issues, PRs, CI runs, and hosted media. Paste what a path on your machine holds instead of naming the path. Say "before this PR" and "after this PR" rather than commit hashes.

### Why

One to three short sentences: who hits the problem, the trigger, what it costs them, and the change that removes its cause. "A reviewer delegate that greps for `pi --print` is refused, so it cannot read the guard it reviews. The guard now splits a command on `;` only outside quotes."

Then one line per ticket: `Closes #N` for a ticket this PR finishes, and `Part of #N (<what this PR does for it>)` for one it advances, with what that ticket still owes posted on the ticket. Add `Depends on #N` when another PR must merge first.

### What changed

One to three short bullets. Name a real symbol or path only when it carries the change, and name both sides of a rename. When a bullet cannot show the shape of the change, put one visual of at most 10 lines next to it:

- Pseudocode for logic.
- A call tree or component tree for control flow or UI structure.
- A shallow file tree for a broad refactor.
- Mermaid for messages or data flow between components.
- A `diff` of any of these when the surrounding shape already exists:

   ```diff
    submitForm
      createSession
   +    expandSkillMention
        launchAgent
   ```

### Scope

One to three short items: what the PR covers, and what it deliberately leaves out, plus one line per known limit.

### Tradeoffs

The alternative a reviewer would propose, and the fact that rules it out.

### Blast Radius

One or two sentences. Name who or what is exposed if the change is wrong and the failure they would see. Then name the door with the fact that decides it. It is two-way when a revert undoes everything, and one-way when something survives a revert, such as migrated data, a published package, a removed public API, a sent message, or a changed default that other machines pick up. For a one-way door, say how to recover. Add what must be true before merge only when something must.

### Verification

One to three bullets, decisive proof first. Each is a witness, the check you ran at this PR's head and what it showed before and after this PR:

```markdown
- **<claim>.** <setup and action>, `<command>`: `<before output>` → `<after output>`.
```

- Run each witness at this PR's head. A run on another head proves that head.
- Show the counterfactual. For a new regression test, give its failure without the fix and its pass with it.
- "Tests pass" and "typecheck passes" are claims. They count only with their output or a CI link.
- For a perf claim, give one `before → after` number with its unit and a link to the method, per the **benchmark-checklist** skill.

End with `**Not checked:**` and each claim or Done-when item that has no witness, with the reason, or `nothing`. When the evidence comment exists, the last line links it.

After the sections, attach the screenshots and recordings that prove a claim. A change a user can see or touch gets before and after screenshots of the same screen in a `| Before | After |` table, and a recording of you using the change as a real user, from the entry point to the result, captured through the repository's `verify-*` skill. For a TUI or CLI, the captured pane is the screenshot and a terminal recording is the video. Caption each with what to look at. Host media through the repository's own uploads, or with the **dumpfile** skill, whose links expire after 30 days, so each caption says what the media showed. Keep PR-only media out of the repository.

## Evidence comment

When an expert would ask more than the briefing answers, put the rest in one PR comment that starts with `## Evidence`:

- A witness for each claim the title and Why make, and for each `## Done when` item of the ticket the PR closes, that Verification does not already show.
- The questions a skeptical expert in this domain would ask about the proof, each as a bold question with its witness. Ask the ones that fit:
   - Does the test fail without the fix?
   - Does the proof run on the surface where the bug was seen, or on a stand-in, and how close is the stand-in?
   - For a change a user sees, does it hold when a real user drives it end to end, including the empty, error, and narrow-screen states?
   - What is the nearest case that should still behave as before, and does it? For a guard or a security check, which bypasses were tried?
   - What shows the rejected alternative fails?
   - For a number, what were the sample size, the spread, and the setup?
- Full logs, each in a `<details>` block under its decisive lines.

After the PR opens, post it with `scripts/publish-pr.ts comment <number> <evidence-file>`, which posts only after `check-body.ts comment` exits 0, reads the comment back, and prints its URL. Then add that URL as the last line of Verification with `scripts/publish-pr.ts edit`.

## Example

The same PR, condensed from a real one and written well:

````markdown
fix(background-terminals): send pending notifications with the end

## Why

When a background terminal ends, the model never sees the notifications it had not read, so it acts on partial information. The report of the terminal's end now carries them.

Closes #73

## What changed

- A terminal's end report carries its pending notifications instead of deleting them.

   ```diff
    terminal ends
   -  delete its pending notifications
   +  attach its pending notifications to the end report
      wake the model with the end report
   ```

## Scope

- Covers notifications still pending when a terminal ends.
- Leaves out terminals lost to a Pi restart, which drop their notifications as before.

## Tradeoffs

Sending each notification ahead of the end costs the model an extra request each, because Pi steers one message per poll.

## Blast Radius

Every session with background terminals, where a wrong batch gives the model a notification twice or not at all. Two-way door, since pending notifications live only in memory.

## Verification

- **A killed watcher's second notification reaches the model** (Done when 1). A `pi --print` run whose watcher the model kills on its first notification: `a-61 end` → `a-61 b-62 end`.
- **The regression test fails without the fix.** `test/steering.test.ts`: `✖ expected note-42 once, received 0 times` → `✔ a terminal that notifies and exits during a turn`.

**Not checked:** macOS, because the e2e suite runs only on Linux here.

Evidence: https://github.com/example/pi/pull/75#issuecomment-1
````

The same PR, written badly:

```markdown
fix(background-terminals): a notification reaches the model when its terminal ends first

## Why

`delivery.terminalSettled(id)` deleted pending notifications. Now `batch("completion")` appends them and `bg_kill` lists them. This is the final PR of the stack: it carries intermediate PRs #71 and #72, and final PR B adds the docs. Closes #73.

## Verification

- The TUI reply is `a-61 end` on stack-base and `a-61 b-62 end` here.
- `vp run verify` passes.
```

Its Why lists symbols instead of a story, tells how the work was produced, and names a PR by a letter only its author knows. It has no Scope, Tradeoffs, or Blast Radius. Its Verification names a branch instead of before and after, counts "passes" as proof, and has no Not checked line.

## Check the body

Write the body to a file and run both gates.

1. **Structure.** Run `scripts/check-body.ts pr <body-file> --title "<title>"`, with `--template <path>` when the repository has a PR template. Fix each printed problem and rerun until it exits 0. Exit 0 means the headings, the title's form and length, the Why length, the body length, the Blast Radius door, and Verification's witness and Not checked line pass. This run and the evidence comment's run both fail on a path on your machine, such as one under `~/`, even inside a code block. It says nothing about the case the body makes. A `warning:` line leaves the exit code alone. It marks a sentence about how the work was produced, or a line that may leave a choice open. Rewrite a production sentence for the reader of this diff, or keep it when that reader needs it to merge or deploy. Settle an open choice before the PR is ready for review: make it when it is yours, answer it from a source, or get its owner's answer and cite it. Otherwise keep the PR a draft.
2. **Expert read.** Start one delegate with `instructionsFile: ~/.pi/agent/instructions/cold-reader.md`, and give it only the title, the body file, and the evidence file when there is one, with no diff, ticket, or chat. Ask it to:
   1. Retell the problem as one story, and why this fix rather than the alternative.
   2. As an expert in this domain who must own the change, list every question it would need answered to trust the proof. For each, quote the line that answers it, or write `unanswered`.
   3. State the blast radius and the door, or write `unclear`.
   4. Quote every sentence it could follow only by knowing how the work was produced, such as other PRs or branches named without what they do, or who checked what. Write `none` when there is none.

   Run the read once. Answer every `unanswered` and `unclear` it reports with a witness in Verification or the evidence comment, or list it under Not checked. Rewrite every quoted sentence as a fact about this PR's change. Then move on without a second read.

Publish the same file with `scripts/publish-pr.ts create <body-file> --title "<title>"` or `scripts/publish-pr.ts edit <number> <body-file> --title "<title>"`, never with a bare `gh pr create --body-file` or `gh pr edit --body-file`. Both verbs take `--repo` and `--template`, `create` also takes `--base`, `--head`, and `--draft`, and `edit` also takes `--replace`. Pass `--draft` when step 1 says to keep the PR a draft. Keep the title out of the body file.

- It reruns check-body and calls `gh` only after check-body exits 0.
- On `edit`, it keeps each `## ` section that the live body has and the file lacks, such as a plan a bot appended, after the section it followed in the live body, and prints `publish-pr: kept "## <heading>" from the live body` for each. To delete such a section on purpose, pass `--replace`, so the file replaces the live body whole, and say so in your report.
- It reads the PR back and compares it with what it sent, ignoring line ends and trailing newlines. On a difference it prints the changed lines.

Its exit code is 0 when the PR is published and reads back the same, 1 when check-body found problems, 64 for a bad argument or an unreadable body or template file, 2 when a `gh` call failed or check-body could not run, and 3 when the readback differs.
