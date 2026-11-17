# PHI router design (v2)

The architect synthesis for `phi/auto` v2. The plan the human agreed is `docs/plan-v2.md` in the work's state folder. This file records the shape the build follows and every change from the plan. It replaces the v1 design, whose session latch ADR 0013 supersedes.

## Problem

Each Claude request goes to a flat-rate personal subscription (`ultra-a` or `ultra-b`) unless its own new content holds a direct identifier of a real patient or member, as the plan's PHI table lists them. Such a request goes to the BAA account `ent`, and the message that holds the identifier is sealed. Later requests return to `ultra` with that message replaced by a stub. The release gate is zero complete direct identifiers in any one message on the wire to `ultra`. An identifier split across a message boundary, each part a fragment, is an accepted risk: reported, not gated. The human ruled so on 2026-11-16: "i accept that risk of cut messages, that is enough defensible legal argument".

Five measured facts shape it.

- Only a wrapper around an account provider's api (`{stream, streamSimple}`) sees every byte sent to that account, `direct` summary requests and pi's send-time compaction included. `context`, `context_with_system` and `before_provider_request` cannot tell the accounts apart (prototype-border Q1, Q7, Q8).
- Extensions share no module state (jiti `moduleCache: false`). `pi.events` carries function values in either load order. `registerProvider` is last-writer-wins, so only claude-accounts may register the accounts (prototype-border Q5).
- Message hashes agree between `route()` and the wrapper, 176 of 176. They differ only after a `context` hook edit, with `blockImages`, for a send-time compaction summary and for a summary request's prompt. Each reaches the wrapper as an unknown message (prototype-border Q3).
- A cold `ent` request writes the whole context to cache at $5 per million tokens, and a warm one reads it at $0.20. `ultra` keeps its own cache across a short excursion (prototype-switch). The BAA org rejects Anthropic message threads with HTTP 400.
- A replay of v1's rules with per-message quarantine reached 72.4% gross but 61.0% net. The judge saw the whole cleared conversation on every request, which cost $322.78 over 44,810 calls (`variants/REPORT.md`). The judge must see new content only.

## Usage

The developer selects `phi/auto` once. `~/.pi/agent/phi-router.json` keeps v1's shape (`mode`, `model`, `baaRepos`, `fixtures`). Without it, or without `mode`, the router runs in `enforce`. To make `phi/auto` the default model, set `defaultProvider: "phi"` and `defaultModel: "auto"` in your own `~/.pi/agent/settings.json`, and add `phi/auto` to `enabledModels` when that list is set, since pi starts on the first enabled model when the default is not among them.

- The footer shows `phi → ultra-a` on most requests. A request that seals shows `phi → ent`. A notice says that one message held patient identifiers and was handled only on `ent`.
- The `ultra` model sees `[withheld: holds patient identifiers, handled on the HIPAA account]` in place of a sealed message. `ent`'s reply follows, and it names patients by internal id.
- `/phi` prints the mode, the pin and the counts of sealed and cleared messages. `/phi pin` keeps the session wholly on `ent` with no judging. `/phi unpin` returns it to routing.

The engine eval, the wire run's border test and the savings replay call the same core as pi:

```ts
const decision = yield * decide({ messages, reason, book, hold }).pipe(Effect.provide(judge));
// { lane: "personal" | "ent", why, found: [[key, verdict]], usage, wouldStub }
const view = guard({ messages, lookup: book.lookup }); // exactly what a personal account receives
```

## Shape

### Data

| Type          | Module             | What it is                                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ContentKey`  | `policy/engine.ts` | SHA-256 over one part's role and content, length-prefixed. It excludes `toolCallId`, timestamps and thinking, so a retry, a resend after compaction and a repeated file read share a key. One function computes it, used by `route()` and the border alike.                                                                  |
| `Part`        | `parts.ts`         | One stub-able unit of a pi-ai `Message`: `{key, slot}`. A system message gives a content part, one part per section and one tools part. Any other message is one part.                                                                                                                                                       |
| `Piece`       | `policy/engine.ts` | What the policy judges: `{key, kind, texts, images, context, seam}`. `kind` is `system`, `user`, `tool-result`, `reply-personal` or `reply-other`. `context` is at most `policy.window` preceding rendered items. `seam` is the cleared end of the previous message of the same role when this one goes on from it mid-word. |
| `Verdict`     | `policy/engine.ts` | `Cleared {by}` or `Sealed {finding}`. `finding` is `Rule {rule, kind}`, `Judge {score, kind}`, `Quote {of}` or `Failure {why}`. Sealed wins over cleared for one key.                                                                                                                                                        |
| `VerdictBook` | `store.ts`         | The router's in-memory map from key to verdict for the session, folded from the session file. One writer, the router extension.                                                                                                                                                                                              |
| `Lookup`      | `border.ts`        | `(key) => "cleared" \| "sealed" \| undefined`. All the border knows about verdicts.                                                                                                                                                                                                                                          |
| `Decision`    | `route.ts`         | `{lane, why, found, usage, wouldStub}`. Account choice comes after it.                                                                                                                                                                                                                                                       |

### The policy module

`src/features/phi-router/policy/` has no `@earendil-works/*` import (`policy/boundary.test.ts`). `policy/policy.ts` is the one written source for the identifier kinds of the plan's table, the defaults the human can change, the judge's question and counter-examples, the exact synthetic-identity list, the thresholds, the judge window and the judge limits. `policyVersion` hashes all of it together with each rule's pattern source and the judge model id, so a change to any of them retires every stored verdict. The rule ids are derived from the rule table, never listed twice.

### Rules

`policy/rules.ts` keeps only unambiguous direct identifiers:

| Rule           | Fires on                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ssn`          | `\d{3}-\d{2}-\d{4}` that passes `isSsn`.                                                                                                            |
| `mbi`          | A Medicare Beneficiary Identifier in its positional alphabet.                                                                                       |
| `hl7-pid`      | An HL7 v2 message whose PID segment fills PID-5 (name) or PID-7 (birth date).                                                                       |
| `fhir-patient` | A `Patient` resource with a filled `name.family` or `given`, `birthDate`, or an `identifier` whose `system` is an SSN, MBI or member-number system. |
| `x12-member`   | An X12 envelope with `NM1*IL` or `NM1*QC` whose name or member id (`NM109`) is filled.                                                              |

Exact synthetic identities are blanked to `[synthetic-id]` before the rules and the judge run, so the rest of the piece is still judged. A rule hit seals the piece. Rules never clear anything. Every label-plus-value rule, `labelled-patient-side`, cut-value matching, `vin`, `npi`, `dea`, `fhir-subject` and the name-proximity rules are gone.

### The judge

- **One question.** "Does `piece` contain a direct identifier of a real patient or member, as the policy lists them?" Its criteria list the kinds and the counter-examples (internal ids, health facts tied to an internal id, schema and SQL, staff and vendor contacts, fragments, counts). `context` is labelled as earlier content, already cleared, for reading only.
- **File names.** A number or code in a file name that names a diagnosis or a patient's document counts, other than a leading internal id. The judge read such a value as a second internal id and cleared it (eight leaks on the v2 corpus). `countingRules` says so with two examples and one counter-example, and the kind question names a record or member number when nothing says which. Wording that asked for the record-or-member label in both questions closed the same leaks but sealed 15 more clean cases, screenshots and internal ids among them.
- **New content only.** A piece is one message, or one system part, plus at most `policy.window` preceding items. For a tool result the first item is its own tool call. The cleared conversation is never sent. The engine eval sweeps the window size and records the misses each size costs. The window is 0. On the v2 corpus, window 0 leaked no more than window 1 at every step of the leak work, sealed a screenshot at 1.00 where window 1 gave 0.63 and window 4 gave 0.06, and costs a fifth less ($0.61 against $0.77 a corpus run). The judge reads `context` as part of `piece`, so context moves scores both ways.
- **Images.** A piece's images go in `ClassifierContext.images`, up to 128 per call. An image is not PHI on sight.
- **Rules first.** The judge runs only when no rule sealed the piece.
- **Once per piece.** The book caches by `ContentKey`.
- **Borderline.** Below 0.2 clears and 0.5 or more seals. In the band a second call asks the kind question ("which direct identifier, or none"). The piece seals only when it names a kind. Decisions seems to answer identical input identically: the three variant runs agreed on every first taint, an inference from one run each (`variants/REPORT.md`). So re-asking the same question would likely repeat the first answer.
- **A message cut mid-word is read with its seam.** A tool output cut at a limit and fetched again, or a value pasted in two messages, splits an identifier so neither half is one. When a user message or tool result starts with no space and the previous cleared message of its role ended on a letter or digit, the rules and the judge read the last 200 characters of that message in front of it. Its key is unchanged. The seam is a prefix of the piece, not `context`, so the judge reads the identifier whole. Three split leaks on the v2 corpus closed with it and over-routing did not move.
- **An `ent` reply that repeats sealed content seals.** `ent` writes its reply from sealed content, so it can quote a record's row without the header that made a value an identifier. Judged alone, such rows cleared (five leaks on the v2 corpus). A new `ent` reply that shares a line of 16 or more characters with a sealed piece before it in the request seals as `Quote`, whatever the judge said, with no extra call. Showing the judge the sealed content beside the reply caught the same leaks but sealed 29 replies that only said "done" or "fetching the rest", because the judge reads `context` as part of `piece`. `policy/quotes.ts` holds the check and `decide` applies it to the request's verdicts.
- **Personal replies skip the judge.** An assistant message whose `provider` is a personal account was written from bytes the border let through, every one of which cleared. Its only new source of an identifier is the model itself, and a made-up identifier is not a real patient's. Rules still run on it, so a valid SSN in a reply still seals. A reply from `ent` (the bridge) is judged.
- **System prompt.** System parts are judged once per digest and cached in a global per-policy-version file. A system part seals only on a rule hit or on a score of 0.5 or more with a named kind. A refused or failed system judgment is retried once and then seals that part narrowly. The 0.23 to 0.34 scores on the harness prompt cost nothing. A sealed system section is stubbed on `ultra`. No session is sealed on its system prompt.
- **Failures seal narrowly.** A judge error, timeout, refusal or oversize input seals that one piece. Unreadable bytes do the same. The request goes to `ent`, and the next one returns to `ultra` with that piece stubbed.

### The verdict store

- **Where.** Session verdicts are custom entries (`phi-verdicts`, `{policy, verdicts: [key, seal, why][]}`) appended by the router extension. The book folds every such entry in the session file, all branches included. A verdict is a fact about content, so the union is correct, forks carry their entries and `/tree` needs no special case. System verdicts live in `~/.local/state/pi-phi-router/system/<policyVersion>/<pid>.jsonl`, one append-only file per pi process, merged on read.
- **Who writes.** The router extension only: `route()` and its `session_compact` handler. The border reads through `lookup`, which the router hands over `pi.events`.
- **Restart.** `session_start` folds the file before any request. A crash between judging and appending loses that request's verdicts, so the next request judges those pieces again. Entries from another policy version are ignored. A malformed entry is skipped, never a latch.

### Sealing

A request seals exactly the pieces that got `Sealed`. Its other new pieces clear on their own. `laneOf` sends `ent` when a part of the request's own new content (the last assistant message and everything after it, and a sealed compaction summary no `ent` reply has followed) is sealed, or when a part sealed during this request. A repeated read of sealed content is sealed new content, so it goes to `ent`. A retry of a sealed request goes to `ent`. Every later request goes to `ultra`, and the border stubs the sealed parts. There is no session latch.

### The guarded lanes

`border.ts` holds a pure `guard({ messages, lookup })` and `guardedApi`. claude-accounts wraps `ultra-a` and `ultra-b` with it in `accountProvider`, the module that registers them, so no later registration can drop it. Its entrypoint passes `phiBorder(pi).wrap` to `claudeAccounts`, because a feature imports another only through its `index.ts` and phi-router already imports claude-accounts.

| Part                           | Cleared                                                    | Sealed or unknown                                                   |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| user, tool result              | pass                                                       | stub text, keeping role, `toolCallId`, `toolName`, `isError`        |
| assistant                      | pass; thinking stripped unless a personal account wrote it | stub text, keeping each tool call's id and name with `{}` arguments |
| system content, system section | pass                                                       | that content or section stubbed                                     |
| system tools                   | pass                                                       | the request is refused with an error stream                         |

Tool-call ids are provider-generated and tool names come from the harness, so neither carries session content.

**Scope.** claude-accounts marks the process protected on `session_start` and `model_select` when the selection is `phi/auto`, and clears it on a switch to any other model (ADR 0017). A protected process guards every request to a personal account: routed, failover, `direct` or a raw selection. An unprotected process is untouched, so non-PHI sessions and their `judgment` delegates pay nothing. A protected process with no link from the router treats every part as unknown, which fails closed.

**What it proves.** In a protected process, no part reaches a personal account unless the router cleared its key, or it is a constant stub. That holds when `route()` dispatches wrongly, when pi compacts at send time, and when the router never loaded. It does not hold when the judge clears PHI. The leak gate tests the judge, and the border test tests dispatch.

The wrapper reports `{stubbedSealed, stubbedUnknown, refused}` per request, which the router logs. `stubbedUnknown` above zero is the drift alarm.

### The `ent` bridge

In a `phi/auto` session the router adds a `phi-bridge` prompt section through `before_agent_start`. It tells the model to refer to patients by internal id only, and says a withheld message was handled on the HIPAA account. Both lanes get the same section, so neither cache breaks on a switch. `ent`'s reply is judged on the next request. If clean, it enters the `ultra` context. If not, it is sealed. The harness summarizer gets the same sentence in a `phi/auto` session.

### Compaction

- **The summary request** (`direct`, from the harness compaction or a `/tree` summary) carries the whole transcript serialized into one message that `route()` never sees, so `route()` sends every `direct` request to `ent`.
- **The summary itself** is judged in the router's `session_compact` handler. pi awaits that handler before it sends the next request, including the send-time send after a threshold compaction (`agent-session.js` `_runAutoCompaction`). A clean summary reaches `ultra` on that same send. A personal account receives a sealed one only as its stub, so no model has read it. It is therefore new content of each request, though it sits before every kept reply, until an `ent` reply follows the compaction on the branch. After `/compact` the next request goes to `ent`. After a threshold compaction pi keeps the route it chose before compacting, so that one send goes to `ultra` with the summary stubbed and the request after it goes to `ent`. The router suggests `/phi pin`. v1's `compactsBeforeSend` estimate is deleted.
- **Price.** One `ent` summary per compaction, written uncached (`cacheRetention: "none"`) at $4 per million input tokens plus output. At pi's 300k-token threshold that is about $1.28 per compaction. Summaries were outside v1's replay base, so the savings replay reports them on their own line.

### Delegates, pin, modes, log, failover, switches, codemode

- **Delegates.** From `phi/auto`, an alias or a personal or `phi` key runs on `phi/auto`, or on `ent/<model>` when the parent is held (pinned, `force-baa`, `baa-repo`, bad settings, or `shadow`). A BAA key passes. Anything else is refused. The child is its own protected process and judges its brief as new content. Its result returns to the parent as a tool result and is judged there.
- **`/phi pin`.** A custom entry `phi-pin {pinned}` on the branch. Pinned requests go to `ent` with no judge calls. Messages from a pinned stretch have no verdicts, so after `/phi unpin` the next request judges them.
- **Modes.** `enforce` dispatches the decision. `shadow` judges, records verdicts, dispatches `ent` and logs `wouldBe` and `wouldStub`. `force-baa` holds.
- **Lane log.** `~/.local/state/pi-phi-router/lanes/<session>.jsonl`. A `route` line holds reason, mode, `wouldBe`, `dispatched`, `why`, piece counts by source (cache, rule, judge, personal reply, fixture, failure), findings as rule ids, kinds, quotes or failure reasons, judge calls, input tokens, cost, milliseconds and `wouldStub`. A `border` line holds the wrapper's counts. No content and no keys, since the hash of a short value such as a bare SSN can be reversed.
- **429.** v1's `limited` stamps stay in the router's virtual-model state. Home is the session's hashed personal account, then the other personal account, then `ent`. `fallbackChain` still sends nothing from `ent` to a personal account.
- **Model switches.** The human's pick stands (ADR 0015). A switch to a raw personal Claude model still passes the border, which stubs every sealed or unjudged message.
- **Codemode.** v1's guard stays. It now matters only for classifier and image models of other providers.
- **Threads.** BAA accounts set `supportsMessageThreads: false`, since the BAA org rejects threads.

## Module map

| File                      | Owns                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `policy/policy.ts`        | Kinds, defaults, questions, counter-examples, synthetic list, thresholds, window, limits, `policyVersion`.                                |
| `policy/rules.ts`         | The five rules, each one pattern with its validation inside it, `firstHit`.                                                               |
| `policy/quotes.ts`        | `quotingReplies`: the `ent` replies that repeat a line of sealed content.                                                                 |
| `policy/synthetic.ts`     | The caller's synthetic list (`Synthetic`) and blanking to `[synthetic-id]`.                                                               |
| `policy/expand.ts`        | Decoders, unchanged from v1.                                                                                                              |
| `policy/engine.ts`        | `ContentKey`, `Piece`, `Verdict`, `Judge`, `verdictsFor`, band logic, failure sealing, synthetic blanking, fixtures.                      |
| `parts.ts`                | `partsOf` and the key function: pi-ai `Message` to stub-able parts. The border reads only this.                                           |
| `pieces.ts`               | `piecesOf`: each part's kind, rendering and the window.                                                                                   |
| `border.ts`               | `guard`, stubs, `guardedApi`, `phiBorder` (scope and link).                                                                               |
| `store.ts`                | `VerdictBook`, the fold, the entry schema, the system cache file.                                                                         |
| `decisions.ts`            | The `Judge` layer over OpenAI Decisions, with images and usage.                                                                           |
| `route.ts`                | `decide`, `laneOf`, `accountFor`.                                                                                                         |
| `dispatch.ts`             | pi's `route()` (`routeWith`), the account and router state, the fail-closed path, the `session_compact` judge, the Decisions judge layer. |
| `gate.ts`                 | `delegateTarget` with `held`, the codemode guard and `unsafeReach`.                                                                       |
| `settings.ts`, `lanes.ts` | Settings, the log.                                                                                                                        |
| `index.ts`                | The virtual model, the `phi-bridge` section, `/phi`, the fold at `session_start`, the border link, `delegateTargetOf`, and the hooks.     |

claude-accounts gains a `wrap` on `accountProvider` and `supportsMessageThreads: false` for BAA accounts. The compaction feature gains one sentence in a `phi/auto` session. A request flows from `index.ts` to `dispatch.ts` to `route.ts` to `policy/engine.ts`. The border flows from pi-ai to `border.ts`.

## v1 subtraction

- **Deleted.** The session latch (`TaintedCursor`, the terminal fast path, `outcomeOf`'s tainted arm, `priorOf`'s malformed latch, `delegateTargetOf`'s cursor read), the whole `Cursor` with its digest chain and whole-context certification (`split`, `vouchedBy`, `seen`), `policy/labelled.ts`, the cut-value fallback in `rules.ts`, image-taints-on-sight, `vin`, `npi`, `dea`, `fhir-subject` and the proximity rules, v1's three questions and placeholder text, `compactsBeforeSend`, and `relabel.ts` with its test and fixture. Tests that pinned only those go with them.
- **Unchanged.** `policy/expand.ts`, `selection.ts`, `settings.ts`, the codemode guard, the mock Anthropic fixture.
- **Changed.** `rules.ts`, `checks.ts`, `digest.ts`, `decisions.ts`, `route.ts`, `gate.ts`, `lanes.ts`, `index.ts`, the corpus eval (no stop at the first taint), recordings (keyed by policy version, piece key and context key), canary tokens (complete versus fragment), and the scenarios (return-to-`ultra` assertions).
- **Merged.** `session.ts` into `pieces.ts` and `store.ts`. `policy/index.ts` becomes `policy/engine.ts`.

## How the evaluations call it

- **Engine eval.** Per case and per request from `requestsOf`, call `decide` with a per-case book, then `guard`. A complete canary in one message of the guarded view of a personal request is a leak. A canary whose parts reached personal requests only in different messages is a split, reported in its own section and never gated (`splitReachOf` in `canary-tokens.ts`). A fragment is reported. Play continues after a seal. It reports per-stratum misses and over-routing, and sweeps the window.
- **Wire run.** Real pi against three mocks. Zero complete canaries in any one personal message, splits across messages reported apart, and positives deliver their canaries to `ent`. Clean cases must reach `ultra`, and sealed content must not appear in any later personal body.
- **Border test.** A scenario whose route forces `ultra-a` on every request, with the real store and border. No sealed or never-judged content may reach a personal mock.
- **Savings replay.** Per session and per recorded request, `decide` with the live judge and a per-session book. Lanes feed the switch-cost model, cold after any compaction or stub that changes a prefix. It reports gross, judge calls, tokens and cost, net with a session bootstrap, the share of requests and cost on `ent`, the top seal triggers, and compaction summaries on their own line.

## Synthesis decision

Three runners sketched the design: candidate 1 on `judgment` (the router is the only scanner and the border an allow-list), candidate 2 on `investigator` (the border classifies every outbound message and can redirect a request to `ent`), and candidate 3 on `divergent` (an attestation ledger written at ingestion). The cross-judge, on `investigator`, scored them 19, 25 and 9 of 30 and recommended candidate 2.

Candidate 1 is the base anyway. The judge preferred candidate 2 mainly because it judges what really leaves, including the summary pi sends at send time without routing again. The `session_compact` handler gives candidate 1 the same property: pi awaits it before that send. Candidate 2 pays for it with an asynchronous `ent` redirect inside the `ultra` stream wrapper, a SQLite verdict database with leases, per-branch delivery receipts and a judge call on every `ultra` reply. That is the largest state model of the three, it puts routing into the transport, and none of it was proven at runtime. Candidate 3 converges on candidate 1's shape (one writer, a denying border, personal replies on rules only), so it confirms the choice.

Grafts and fixes:

- From candidate 2: summaries are written on `ent` and the summary itself is judged before it reaches `ultra`. That replaces candidate 1's whole-transcript judgment, which broke the new-content-only rule and could not see the prompt pi sends. Also the net formula for the replay, which counts what `ent` really charges.
- From the judge: a refused system judgment seals that part narrowly instead of clearing it. `policyVersion` hashes the rule sources and the judge model, not only the rule ids. Rule ids are derived, not listed twice. The replay treats a changed prefix as cold. The personal-reply rationale rests on every input having cleared, not on both accounts holding the same bytes.
- From candidate 3: the internal-id instruction for the summarizer.

Rejected:

- Candidate 2's border-owned classification and `ent` redirect, for the reasons above.
- Candidate 3's removal of `selection.ts`. The border guards only the Claude accounts, so a switch to another provider would carry sealed content. ADR 0015 later removed it, because a switch is the human's call.
- Candidate 3's global cross-session verdict cache. It would put hashes of conversation content in a new file, and the hash of a short value can be reversed.
- Candidate 1's clean-session summaries on `ultra`. They relied on judging a blob `route()` never sees.

## Changes to the plan

1. "Borderline scores are re-asked. Both answers must agree to seal." The re-ask is a second question (the kind) rather than the same one, because Decisions repeats its answer on identical input. A seal needs both a band score and a named kind.
2. `direct` summary requests always go to `ent`, and the summary is judged before any send. The plan left compaction open.
3. A refused or failed judgment of a system part seals that part (stubbed on `ultra`), not the session.

## Tradeoffs accepted

- We accept that the border cannot rescue a judging error, in exchange for a border with no I/O, no await and no second writer.
- We accept one uncached `ent` summary per compaction (about $1.28 at the threshold), in exchange for summaries that keep sealed content and a border that never judges.
- We accept that a sealed summary reaches only `ent`, on the first request routed after the compaction, and that `ultra` lacks that history until the next compaction, with a pin suggestion, in exchange for no latch. After a threshold compaction one send goes to `ultra` with the summary stubbed, because pi keeps the route it chose before compacting.
- We accept a verdict keyed by content alone, so one tool result's verdict is reused after a different tool call, in exchange for one key function and a cache that catches repeated reads.
- We accept a judge round trip before each request that brings a tool result, a user message or an `ent` reply. Personal replies skip it.
- We accept that sessions that keep touching real patient records bounce between lanes and pay a cold `ent` write per bounce. `/phi pin` is the answer for them.
- We accept that a future `context` hook or `blockImages` makes edited messages unknown, so they are stubbed on `ultra`. `stubbedUnknown` in the log shows it.

## Alternatives considered

- The border classifies at send time (candidate 2). It judges exactly what leaves, but it makes two decision points for one request and needs a redirect inside the transport. See the synthesis decision.
- Verdicts in a sidecar file. Forks get new session ids, and the file would hold content hashes somewhere new. Custom entries follow the session tree for free.
- Re-registering the accounts from the router. Last-writer-wins dropped the guard in the prototype (prototype-border Q5b).

## Known limits

- The border proves dispatch safety. Judge accuracy is proved only by the leak gate.
- An identifier cut across two messages, such as a birth date `YYYY-` in one and `MM-DD` in the next, can reach `ultra` in both halves when the cut falls outside the seam rule. The human accepted that risk, and the gate reports such cases without failing.
- Bash, MCP servers and other tools can send content anywhere. The router governs model requests only.
- Two personal plans may not absorb the moved usage. Overflow fails over to `ent`, at `ent` prices.
- A personal reply that combines cleared fragments into a complete identifier is checked by the rules only.

## Open questions for the human

1. The exact synthetic identities: the vendor QA test member id, the staging client-code prefix, and any placeholder such as `John Doe` or `123-45-6789`. The list starts empty, plus fixture hashes from settings.
2. Should `ent` use pi's one-hour cache (`$8` per million to write), so repeated excursions within an hour read instead of write? The replay can price both.
