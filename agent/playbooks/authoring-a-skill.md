---
when: Writing, porting, or editing a SKILL.md or another file agents follow (a playbook, a principle, a role file, SYSTEM.md, AGENTS.md), or a skill broke mid-task.
---

### Authoring or modifying a skill

**You own the skill's voice.**

1. Use the **writing-for-agents** skill.
2. Validate the skill: frontmatter has `name` and `description`, referenced files exist, cross-skill links resolve.
3. Test cases if structural. Skip if subjective.
4. Run **Opening a PR**.

When in doubt, delete. Keep only prose that changes a decision. Tell it to do the thing and skip the reason. Explain only when the rule is confusing without one. Match tone to scope. Point at structural sources (types, READMEs, config) per **principle-encode-lessons-in-structure**. Delegate to other skills by path. Don't restate. A workflow you keep hitting but isn't captured → propose a new skill.

**Reply:** summary of the skill, key design decisions, validation notes.
