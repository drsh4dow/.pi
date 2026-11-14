---
name: reflect
description: "Asked to reflect on the session, or for the lessons it holds for a skill: three parallel reviewers mine it and route each learning to an edit on an existing skill."
for: [root]
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or invokes the **reflect** skill. Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, find this conversation's transcript, the pi session file under `~/.pi/agent/sessions/` that `$PI_SESSION_FILE` names. Do not glob across `~/.pi/agent/sessions/*/`. That crosses workspace boundaries and reads private chats from unrelated projects.

```bash
echo "$PI_SESSION_FILE"
```

A workspace's sessions sit in its own folder (`<workspace>/<timestamp>_<id>.jsonl`), and its delegates' sessions in the `delegates/` folder beside them. If the variable is empty, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

Three delegates, started with one `group` name. Reviewers need MCP access to look up the tickets, chat threads, and observability traces the transcript references.

Each reviewer and the synthesizer name a model alias. Set the delegate's `model` to it, and its `role` to `leaf`.

| Lens      | `model`        | Prompt template                    |
| --------- | -------------- | ---------------------------------- |
| Judgment  | `judgment`     | `references/judgment-reviewer.md`  |
| Tooling   | `investigator` | `references/tooling-reviewer.md`   |
| Divergent | `judgment`     | `references/divergent-reviewer.md` |

Pass each template verbatim as the delegate's task message, substituting the transcript path or digest where marked. Reviewers return findings in their answer.

## 3. Synthesize

One delegate on the `judgment` model. It spot-verifies citations through MCP. Pass `references/synthesizer.md` verbatim as its task message, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See principle-encode-lessons-in-structure.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit or filing any Backlog item. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

Before approval, show each edit's destination, `.pi/skills/<skill>/` or `~/.pi/agent/skills/<skill>/`. Never open a PR or push.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): hand to the **writing-for-agents** skill and run its draft / test / iterate loop.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): hand to the **writing-for-agents** skill and run its description-optimization loop.
- `new skill via writing-for-agents: <kebab-name>`: hand creation to the **writing-for-agents** skill. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
