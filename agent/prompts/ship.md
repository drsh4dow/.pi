---
description: Run the pre-launch checklist via parallel fan-out to specialist personas, then synthesize a go/no-go decision
argument-hint: "[scope]"
---

Load the `shipping-and-launch` skill.

`/ship` is a **fan-out orchestrator**. It runs three specialist personas in parallel against ${@:-the current change}, then merges their reports into a single go/no-go decision with a rollback plan. The personas operate independently — no shared state, no ordering — which is what makes parallel execution safe and useful here.

## Phase A — Parallel fan-out

Start three delegates concurrently with the `delegate` tool. **Start all three in one turn with one `group` name, so they execute in parallel** — sequential calls defeat the purpose of this command.

Each call passes `instructionsFile: "~/.pi/agent/instructions/<persona>.md"` for its persona:

1. **`code-reviewer`** — Run a five-axis review (correctness, readability, architecture, security, performance) on the staged changes or recent commits. Output the standard review template.
2. **`security-auditor`** — Run a vulnerability and threat-model pass. Check OWASP Top 10, secrets handling, auth/authz, dependency CVEs. Output the standard audit report.
3. **`test-engineer`** — Analyze test coverage for the change. Identify gaps in happy path, edge cases, error paths, and concurrency scenarios. Output the standard coverage analysis.

If you have no `delegate` tool (a delegate at the last level), follow each persona's instructions file sequentially and treat their outputs as if returned in parallel — the merge phase still works.

Constraints (from pi's delegate model):

- A persona does not start another persona.
- Each delegate gets its own context window and one message, cannot ask questions, and returns only its report (its last message) to this main session.
- Delegates cannot talk to each other; they only report back (see `~/.pi/agent/references/orchestration-patterns.md`).

**Persona resolution.** `/ship` runs the personas in `~/.pi/agent/instructions/code-reviewer.md`, `security-auditor.md`, and `test-engineer.md`. Edit those files to customize them — `/ship` picks up your customizations automatically.

## Phase B — Merge in main context

Once all three reports are back, the main agent (not a sub-persona) synthesizes them:

1. **Code Quality** — Aggregate Critical/Required findings from `code-reviewer` and any failing tests, lint, or build output. Resolve duplicates between reviewers.
2. **Security** — Promote any Critical/High `security-auditor` findings to launch blockers. Cross-reference with `code-reviewer`'s security axis.
3. **Performance** — Pull from `code-reviewer`'s performance axis; cross-check Core Web Vitals if applicable.
4. **Accessibility** — Verify keyboard nav, screen reader support, contrast (not covered by the three personas — handle directly here, or invoke the accessibility checklist).
5. **Infrastructure** — Env vars, migrations, monitoring, feature flags. Verify directly.
6. **Documentation** — README, ADRs, changelog. Verify directly.

## Phase C — Decision and rollback

Produce a single output:

```markdown
## Ship Decision: GO | NO-GO

### Blockers (must fix before ship)

- [Source persona: Critical finding + file:line]

### Recommended fixes (should fix before ship)

- [Source persona: Important finding + file:line]

### Acknowledged risks (shipping anyway)

- [Risk + mitigation]

### Rollback plan

- Trigger conditions: [what signals would prompt rollback]
- Rollback procedure: [exact steps]
- Recovery time objective: [target]

### Specialist reports (full)

- [code-reviewer report]
- [security-auditor report]
- [test-engineer report]
```

## Rules

1. The three Phase A personas run in parallel — never sequentially.
2. Personas do not call each other. The main agent merges in Phase B.
3. The rollback plan is mandatory before any GO decision.
4. If any persona returns a Critical finding, the default verdict is NO-GO unless the user explicitly accepts the risk.
5. **Skip the fan-out only if all of the following are true:** the change touches 2 files or fewer, the diff is under 50 lines, and it does not touch auth, payments, data access, or config/env. Otherwise, default to fan-out. `/ship` is designed for production-bound changes — when the blast radius is non-trivial, run the parallel review even if the diff looks small.
