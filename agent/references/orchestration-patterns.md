# Orchestration Patterns

Reference catalog of agent orchestration patterns this repo endorses, plus anti-patterns to avoid. Read this before adding a new slash command that coordinates multiple personas, or before introducing a new persona that "wraps" existing ones.

The governing rule: **the user (or a slash command) is the orchestrator. Personas do not invoke other personas.** Skills are mandatory hops inside a persona's workflow.

---

## Endorsed patterns

### 1. Direct invocation (no orchestration)

Single persona, single perspective, single artifact. The default and the cheapest option.

```
user → code-reviewer → report → user
```

**Use when:** the work is one perspective on one artifact and you can describe it in one sentence.

**Examples:**

- "Review this PR" → `code-reviewer`
- "Find security issues in `auth.ts`" → `security-auditor`
- "What tests are missing for the checkout flow?" → `test-engineer`

**Cost:** one round trip. The baseline you should always compare orchestrated patterns against.

---

### 2. Single-persona slash command

A slash command that wraps one persona with the project's skills. Saves the user from re-explaining the workflow every time.

```
/webperf → web-performance-auditor → report
```

**Use when:** the same single-persona invocation happens repeatedly with the same setup.

**Examples in this repo:** `/webperf`.

**Cost:** same as direct invocation. The slash command is just a saved prompt.

**Anti-signal:** if the slash command's body is mostly "decide which persona to call," delete it and let the user call the persona directly.

---

### 3. Parallel fan-out with merge

Multiple personas operate on the same input concurrently, each producing an independent report. A merge step (in the main agent's context) synthesizes them into a single decision.

```
                    ┌─→ code-reviewer    ─┐
/ship → fan out  ───┼─→ security-auditor ─┤→ merge → go/no-go + rollback
                    └─→ test-engineer    ─┘
```

**Use when:**

- The sub-tasks are genuinely independent (no shared mutable state, no ordering dependency)
- Each sub-agent benefits from its own context window
- The merge step is small enough to stay in the main context
- Wall-clock latency matters

**Examples in this repo:** `/ship`.

**Cost:** N parallel sub-agent contexts + one merge turn. Higher than direct invocation, but faster wall-clock and produces better reports because each sub-agent stays focused on its single perspective.

**Validation checklist before adopting this pattern:**

- [ ] Can I run all sub-agents at the same time without ordering issues?
- [ ] Does each persona produce a different _kind_ of finding, not just the same finding from a different angle?
- [ ] Will the merge step fit in the main agent's remaining context?
- [ ] Is the user's wait time long enough that parallelism is actually noticeable?

If any answer is "no," fall back to direct invocation or a single-persona command.

---

### 4. Sequential pipeline driven by the user

The user asks for each phase in order, carrying context (or commit history) between them. There is no orchestrator agent — the user IS the orchestrator.

```
user asks for:  spec  →  plan  →  build  →  test  →  review  →  ship
```

**Use when:** the workflow has dependencies (each step needs the previous step's output) and human judgment between steps adds value.

**Examples in this repo:** the entire DEFINE → PLAN → BUILD → VERIFY → REVIEW → SHIP lifecycle.

**Cost:** one sub-agent context per step. Free for the orchestration layer because there is no orchestrator agent.

**Why not automate it:** an LLM "lifecycle orchestrator" would (a) lose nuance between steps because it has to summarize for hand-off, (b) skip the human checkpoints that catch wrong-direction work early, and (c) double the token cost via paraphrasing turns.

---

### 5. Research isolation (context preservation)

When a task requires reading large amounts of material that shouldn't pollute the main context, spawn a research sub-agent that returns only a digest.

```
main agent → research sub-agent (reads 50 files) → digest → main agent continues
```

**Use when:**

- The main session needs to stay focused on a downstream task
- The investigation result is much smaller than the input it consumes
- The decision quality benefits from the main agent having room to think after

**Examples:** "Find every call site of this deprecated API across the monorepo," "Summarize what these 30 ADRs say about caching."

**Cost:** one isolated sub-agent context. Worth it any time the alternative is loading hundreds of files into the main context.

**In pi, start a plain `delegate` on the `scout` model** rather than defining a custom research persona. `scout` is a fast model for mechanical search and aggregation, and the delegate returns only its last message, which fits this pattern. Define a custom research instructions file only when a plain delegate doesn't fit (e.g. you need a domain-specific system prompt the model wouldn't infer).

---

## Pi compatibility

This catalog is harness-agnostic, but this harness runs it on pi. Here's how each pattern maps onto pi's primitives — and where the platform enforces our rules for us.

### Where personas live

Personas are instructions files in `~/.pi/agent/instructions/`: `code-reviewer.md`, `security-auditor.md`, `test-engineer.md`, and `web-performance-auditor.md`. Start one as a delegate with `instructionsFile: "~/.pi/agent/instructions/<persona>.md"`. No path configuration needed.

### Delegates, not teams

Pattern 3 (parallel fan-out with merge) maps to **delegates**. A delegate starts in a fresh context, gets exactly one message, cannot ask questions, and returns its last message as its report. Pi has no primitive for teammates that message each other or share a task list.

A persona's instructions file carries no skill list. A delegate sees the same skill list as a regular session, so if a persona depends on a specific skill, name it in the persona's body and the delegate loads it by reading its `SKILL.md`.

### Platform-enforced rules

One rule in this catalog is partly enforced by pi:

- **Delegate depth is capped.** An agent at the last level has no `delegate` tool, so a chain of delegates cannot grow without bound. A persona started from the main session still has a `delegate` tool, so Anti-pattern B (persona-calls-persona) and Anti-pattern D (deep persona trees) are blocked by convention here, not by construction.

This means contributors can still build the anti-patterns by accident. The "Do not invoke from another persona" rule in each persona's Composition section is what stops them.

### Delegate setups to know about

Before defining a custom persona, check whether one of these covers the role:

| Setup                                                                        | Purpose                                                                                  |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `delegate` with `model: "scout"`                                             | Mechanical codebase search and aggregation. Use this for Pattern 5 (research isolation). |
| `delegate` with `instructionsFile: "~/.pi/agent/instructions/researcher.md"` | Read-only web research on one sub-question.                                              |
| plain `delegate`                                                             | Multi-step tasks needing both exploration and modification.                              |

Don't redefine these. Layer your specialist personas (code-reviewer, security-auditor, test-engineer) on top of them.

### Frontmatter restrictions for persona files

An instructions file's frontmatter is a strict profile: only `model`, `thinking` (off|minimal|low|medium|high|xhigh|max), and `readonly` (boolean) are allowed, and any other key is an error. `readonly: true` removes the edit and write tools. Use `model` per persona to route it to the alias its work calls for (e.g. `investigator` for `security-auditor`, `judgment` for `cold-reader`).

### Spawning multiple delegates in parallel

In pi, parallel fan-out (Pattern 3) requires starting **every `delegate` before waiting on any**, then gathering them with the `group` tool (`mode: "all"` for one wake with every result). Waiting on each delegate before starting the next serializes execution. `/ship` calls this out explicitly. Any new orchestrator command should do the same.

---

## Worked example: competing-hypothesis debugging

Some harnesses offer teams whose members message each other to disprove each other's theories. Pi has no such primitive: delegates only report back. This example shows the case and what to do instead.

### The scenario

> _Checkout occasionally hangs for ~30 seconds before completing. It happens roughly once every 50 sessions. No errors in logs. Started after last week's release._

Plausible root causes (mutually exclusive, all fit the symptoms):

1. A race condition in the new payment-confirmation flow
2. An auth check that occasionally falls through to a slow synchronous network call
3. A missing index on a query that scales with cart size
4. A flaky third-party API where the SDK retries silently before timing out

A single agent will pick the first plausible theory and stop investigating. A `/ship`-style delegate fan-out would have each persona report independently — but their reports never meet, so nothing rules out the wrong theories.

`/ship` is a verdict, not an investigation.

### Anti-pattern in this scenario

Do **not** rebuild this as a `/debug` slash command that fans out delegates. Delegates can't message each other — you'd lose the adversarial debate that makes the pattern work. Keep the investigation in the main session with the `debugging-and-error-recovery` skill.

---

## Anti-patterns

### A. Router persona ("meta-orchestrator")

A persona whose job is to decide which other persona to call.

```
/work → router-persona → "this needs a review" → code-reviewer → router (paraphrases) → user
```

**Why it fails:**

- Pure routing layer with no domain value
- Adds two paraphrasing hops → information loss + roughly 2× token cost
- The user already knew they wanted a review; they could have asked for one directly
- Replicates the routing that skill descriptions already do

**What to do instead:** sharpen the skill's description so a plain request reaches it.

---

### B. Persona that calls another persona

A `code-reviewer` that internally invokes `security-auditor` when it sees auth code.

**Why it fails:**

- Personas were designed to produce a single perspective; chaining them defeats that
- The summary the calling persona passes loses context the called persona needs
- Failure modes multiply (which persona's output format wins? whose rules apply?)
- Hides cost from the user

**What to do instead:** have the calling persona _recommend_ a follow-up audit in its report. The user or a slash command runs the second pass.

---

### C. Sequential orchestrator that paraphrases

An agent that runs the spec, the plan, the build, and the rest on the user's behalf.

**Why it fails:**

- Loses the human checkpoints that catch wrong-direction work
- Each hand-off summarizes context — accumulated drift over a long pipeline
- Doubles token cost: orchestrator turn + sub-agent turn for every step
- Removes user agency at exactly the points where judgment matters most

**What to do instead:** keep the user as the orchestrator. Document the recommended sequence in `README.md` and let users invoke it.

---

### D. Deep persona trees

`/ship` calls a `pre-ship-coordinator` that calls a `quality-coordinator` that calls `code-reviewer`.

**Why it fails:**

- Each layer adds latency and tokens with no decision value
- Debugging becomes a multi-level investigation
- The leaf personas lose context to multiple summarization steps

**What to do instead:** keep the orchestration depth at most 1 (slash command → personas). The merge happens in the main agent.

---

## Decision flow

When considering a new orchestrated workflow, walk this flow:

```
Is the work one perspective on one artifact?
├── Yes → Direct invocation. Stop.
└── No  → Will the same composition repeat?
         ├── No  → Direct invocation, ad hoc. Stop.
         └── Yes → Are sub-tasks independent?
                  ├── No  → Sequential phases run by the user (Pattern 4).
                  └── Yes → Parallel fan-out with merge (Pattern 3).
                           Validate against the checklist above.
                           If any check fails → fall back to single-persona command (Pattern 2).
```

---

## When to add a new pattern to this catalog

Add a new entry only after:

1. You've used the pattern at least twice in real work
2. You can name a concrete artifact in this repo that demonstrates it
3. You can explain why an existing pattern wouldn't have worked
4. You can describe its anti-pattern shadow (what people will mistakenly build instead)

Premature catalog entries become aspirational documentation that no one follows.
