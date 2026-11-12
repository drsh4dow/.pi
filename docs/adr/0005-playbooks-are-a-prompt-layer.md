# Playbooks are a prompt layer that loads like principles

Skills and principles each fire on their own trigger, so nothing gave a kind of work its ordered steps. pstack, Lauren Tan's playbooks, skills and principles (cursor/plugins at `a5539b1`), does that with playbooks: one workflow per kind of work, such as a bug fix, a feature or opening a PR. We made the playbook a third prompt layer beside the skill and the principle.

A playbook is `agent/playbooks/<name>.md`, with the frontmatter a principle has: a one-line `when` and an optional `for`. Files in the subfolders of `agent/playbooks/` are reference files, not playbooks. The prompt lists each playbook that fits the agent's role as `name: when` in `<playbooks dir="…">`, and `<playbooks-workflow>`, which the prompt feature writes just before that list, has the agent read every playbook whose `when` matches before it acts. Playbooks load the way principles do. Several can apply, and a step can send the agent to another playbook. The agent announces none of them. It runs their steps in order and names a step it skips in its report as `skip: <reason>`.

## Considered options

- **A router skill with the playbooks beside it, as pstack ships it.** pstack's `poteto-mode` skill lists the playbooks, and pstack needs a Cursor Custom Mode to keep that skill in context. In pi, a skill is in context only after the model chooses to read it. The prompt is always in context, so the list goes there.
- **Playbooks as ordinary skills, as Addy Osmani's agent-skills ships its lifecycle.** A skill is a technique that any step can use. A playbook is the base of the session's workflow. One list for both hides which is which.
- **The layer of 2026-11-10 (commit `da53f3a`).** It listed playbooks for the root only. The root matched each task to one playbook, opened its first reply with a `Playbook:` line, or `Playbook: none`, and copied the playbook's steps into that reply. The human removed it because "we are requiring the agent to state which playbook is using". He wants the agent to "shape its own session workflow using the playbooks as base, even when multiple applies".

## Consequences

- Addy Osmani's lifecycle skills are gone. The eight that a pstack playbook or skill covers were deleted, such as `spec-driven-development` and `test-driven-development`. The other fifteen became playbooks with their bodies unchanged, so `/skill:<name>` no longer runs them.
- A name is unique across skills and playbooks, because "the **name** skill" and `playbooks/<name>.md` must each point at one file. The collision check in `features/prompt/routing.test.ts` fails on a shared name. Matt Pocock's `prototype` skill is renamed `prototyping`, since pstack's Prototype playbook has the name.
- A playbook's `when` and a skill's description sit in one prompt, so the same collision check fails on a `when` that reads like a skill's description.
- herdr-app's Skills panel counts a playbook the agent read as a guide.
