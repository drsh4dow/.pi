---
status: proposed
---

# A merge needs a verdict at the pull request's head, and a local `gh` wrapper checks it

A delegate's "done" was free text, so in two 24-hour sessions with 507 delegates, partial evidence passed for a pass and merges outran reviews. Root A merged two PRs "without reading the source myself", merged a third with changes requested, and got a fourth's verdict after the merge. Root B merged six PRs with review exceptions at the merged head.

So a merge needs a recorded verdict. A `gh` wrapper that comes first on the agent's PATH reads the arguments of every `gh` call. On a merge it refuses unless a pass verdict sits at the pull request's current head, or at an older head whose pull request diff has the same `git patch-id --verbatim`. The plain `git patch-id` ignores whitespace, so it would carry a verdict from `print("a b")` to `print("ab")`. Any other head needs a fresh verdict. When it lets a merge through, it passes the checked head to the real merge as `--match-head-commit`, so a push between the check and the merge fails the merge.

The head pin binds only a merge that happens now. A merge that GitHub completes later, such as `gh pr merge --auto` or auto-merge enabled through the API, lands whatever head is ready then. A head pushed after the check could land with no verdict. So the gate refuses a deferred merge. An agent waits for the pull request's checks instead, then merges with the head pinned.

A merge that lands several pull requests, such as `gh stack merge <ceiling>`, names only the ceiling, yet lands every pull request below it too. The gate works out every pull request the merge would land and needs a pass at each one's head, or one that carries to it. When it cannot work out which pull requests those are, it refuses the whole merge.

A verdict is a pass, a pass with notes, a fail, or incomplete. Incomplete is not a fail. It records that the verifier could not finish, or that its answer carried no verdict line, so missing evidence never becomes a pass. Only a pass or a pass with notes lets a merge through.

A pass from a leaf that the pull request's author started is enough. The playbooks still ask for a verifier on another model family, and the gate does not check which model gave the verdict.

The patch rule turns step 3 of the Shipping playbook into code: a rebase that leaves the patch unchanged keeps its verdict. It drops that step's judgment call on patches that differ only in tests, docs or lint config. Those now need a fresh verdict, so the gate needs no model.

The gate covers every merge it sees, with no exemption list. That includes merges between work branches, which a grant already allows, and pull requests that change only docs. Agents have no override. When the human wants a merge the gate refuses, he makes it from his own shell or GitHub's site.

## Considered options

- **Verdicts as GitHub commit statuses, made a required check.** Stronger, because it would also stop a merge from GitHub's site or from any other client. Not now. It needs admin rights on every target repository and a GitHub App to post the status, and it publishes to repositories the human does not administer. When the design was checked, `drsh4dow/.pi` had no rulesets and the work repository answered 404. It stays open for later, on repositories where the human has admin rights.
- **Match the text of tool calls, such as a `tool_call` handler that looks for `gh … merge`.** Rejected. It misses a command built inside a codemode script, `gh api`, `gh stack merge` and `--auto`, and the harness already dropped a shell-text guard on `pi --print` for its false positives. The wrapper sees the arguments `gh` itself receives.
- **A verdict only at the exact head.** Rejected. A stack rebase moves every PR above it to a new SHA without changing its patch, so each would need a new review.
- **Exempt merges between work branches, or docs-only changes.** Rejected. Each exemption brings back the judgment call the patch rule removes, and a fresh verdict costs $0.15 to $1.03 by the retro's measure.
- **Allow auto-merge on a head that has a pass**, as step 4 of the Shipping playbook does today. Rejected. GitHub completes the merge later without the local gate, at whatever head is ready. Only a required check on GitHub would close that, and that is the commit-status option above.
- **An override for agents.** Rejected. Root B merged six PRs with review exceptions at the merged head, and an override would put such an exception one flag away.

## Consequences

- The gate sees only the `gh` calls that reach it. An agent can still merge by calling the real `gh` by its full path, or through GitHub's API with another client such as `curl`. The gate stops ordinary merges, not a deliberate bypass.
- Whether `gh stack merge` can pin the head of each pull request it lands is unproven. If it cannot, a push between the check and a stack merge can still land without a verdict, and the change that builds the gate says so.
- pi puts its bin folder first on PATH only when PATH lacks it, so the wrapper's place on PATH is a fact to test in a root and in a delegate.
- Steps 3 and 4 of the Shipping playbook change with the gate. Step 3 still describes the judgment call on patches, and step 4 still arms `--auto` on a verified head.
