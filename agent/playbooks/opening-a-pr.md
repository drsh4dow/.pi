---
when: Opening a PR, a pull request that puts a branch up for review, invoked at the end of every other playbook.
---

### Opening a PR

**Commits.** Commit liberally. Rebase into small, ordered commits before opening PRs. Each commit is landable and ordered to tell the story. Amend when the fix belongs in a just-made commit. New commit when separable. Commit bodies don't restate the subject.

**PRs.** Run `playbooks/code-simplification.md` over the diff before commit and the **no-comments** skill before review. Write every PR title, description, and commit body with the **technical-writing** skill (every layer except Diátaxis, and apply the STE vocabulary rules: one word per action, keep articles, a plain verb over `-ing` where one works), then apply the **unslop** skill.

**Titles.** Conventional Commits `type(scope): subject`, no trailing period. Type such as `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf`. Scope is the area, such as `playbooks` or `owned-work`. Subject is short, imperative, and names a real symbol when one carries the change, for example `fix(playbooks): retarget opening-a-pr babysit trigger`.

**Descriptions.** Write, check, and publish the body with the **writing-good-prs** skill.

**Forge.** Use GitHub CLI (`gh`) for create, edit, view, watch, and merge, and `gh stack` for a stack.

**Stacks.** A stack is a base-branch chain. The root PR targets trunk. Each child branch rebases onto its parent's exact tip and its PR targets the parent branch. As a parent merges, move its child onto trunk per `playbooks/shipping.md` step 4. Track the branches with `gh stack init --base <trunk> <branch>...` (bottom to top) or add one on top with `gh stack add <branch>`, then cascade a rebase with `gh stack rebase` and push with `gh stack push`. Create a child with `gh pr create --base <parent-branch>`, retarget one with `gh pr edit <pr> --base <parent-branch>`, and link the PRs into a stack with `gh stack link <bottom-pr> ... <top-pr>`. Branch from trunk only for independent work. Rebase on trunk before substantial stack work.

**Readiness.** Open every PR ready, never as a draft. With `gh`, omit `--draft`. If a PR still opens as a draft, run `gh pr ready <number>`. Run `gh pr view <number>` before you refer to PR status.

**Babysit.** Opening a PR does not start a babysit. Post the URL and keep building. Finish the phase or stack first. Run a separate babysit pass once the whole stack exists. A babysit for each new PR stalls the build and spends checks on commits later waves restart. Push back when feedback drifts from intent.

A delegate that opens a PR runs `playbooks/code-simplification.md` and the **no-comments** skill, and posts the URL. It returns to the parent without babysitting, unless it is an Autopilot-full or Autopilot-stack owner. That owner's brief assigns the babysit loop and is the ask `playbooks/babysit.md` waits for. The owner starts the loop after its code-ready report, reports merge-ready, and is exempt from the rules here and in `playbooks/babysit.md` that hold babysitting until a whole stack is built.
