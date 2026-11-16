---
when: Opening a PR, a pull request that puts a branch up for review, invoked at the end of every other playbook.
---

### Opening a PR

Invoked at the end of every other playbook.

**Worktree.** Work from a git worktree off main. Delegates inherit it. Multiple delegates on the same branch each get their own worktree, or `git fetch && git reset --hard origin/<branch>` between them. Dirty branch with unrelated work: patch out, fresh worktree, apply. Snarled worktree: reset from main, redo minimally.

**Commits.** Commit liberally. Rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Amend when the fix belongs in a just-made commit. New commit when separable. Commit bodies don't restate the subject.

**PRs.** Run `playbooks/code-simplification.md` over the diff before commit and the **no-comments** skill before review. Write every PR title, description, and commit body with the **technical-writing** skill (every layer except Diátaxis, and apply the STE vocabulary rules: one word per action, keep articles, a plain verb over `-ing` where one works), then apply the **unslop** skill.

**Titles.** Conventional Commits `type(scope): subject`, no trailing period. Type such as `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf`. Scope is the area, such as `playbooks` or `owned-work`. Subject is short, imperative, and names a real symbol when one carries the change, for example `fix(playbooks): retarget opening-a-pr babysit trigger`.

**Descriptions.** Write, check, and publish the body with the **writing-good-prs** skill.

**Forge.** Use GitHub CLI (`gh`) for create, edit, view, watch, and merge, and `gh stack` for a stack.

**Size and stacks.** Work branches are yours. Create, push, rebase, and merge PRs between them as you need. A shared branch is one several people use, such as staging, prod, or main. PRs against a shared branch are few, self-contained, and easy to review without losing context. Weigh the number of PRs against how self-contained each one is, and fewer usually wins. A stack is a base-branch chain. The root PR targets trunk. Each child branch rebases onto its parent's exact tip and its PR targets the parent branch. As a parent merges, move its child onto trunk per `playbooks/shipping.md` step 4. Track the branches with `gh stack init --base <trunk> <branch>...` (bottom to top) or add one on top with `gh stack add <branch>`, then cascade a rebase with `gh stack rebase` and push with `gh stack push`. Create a child with `gh pr create --base <parent-branch>`, retarget one with `gh pr edit <pr> --base <parent-branch>`, and link the PRs into a stack with `gh stack link <bottom-pr> ... <top-pr>`. Branch from trunk only for independent work. Rebase on trunk before substantial stack work.

**Readiness.** Open every PR ready, never as a draft. With `gh`, omit `--draft`. If a PR still opens as a draft, run `gh pr ready <number>`. Run `gh pr view <number>` before you refer to PR status.

**Babysit.** Opening a PR does not start a babysit. Post the URL and keep building. Finish the phase or stack first. Run a separate babysit pass once the whole stack exists. A babysit for each new PR stalls the build and spends checks on commits later waves restart. Push back when feedback drifts from intent.

A delegate that opens a PR runs `playbooks/code-simplification.md` and the **no-comments** skill, and posts the URL. It returns to the parent without babysitting, unless it is an Autopilot-full or Autopilot-stack owner. That owner's brief assigns the babysit loop and is the ask `playbooks/babysit.md` waits for. The owner starts the loop after its code-ready report, reports merge-ready, and is exempt from the rules here and in `playbooks/babysit.md` that hold babysitting until a whole stack is built.
