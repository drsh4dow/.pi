# PHI router design

The architect synthesis for `phi/auto`. The plan the human approved is in the work's state folder (`docs/plan.md`); this file records the shape the build follows and every change from the plan's sketch.

## Problem

Each pi request should go to a personal Claude subscription (`ultra-a` or `ultra-b`) when it carries no PHI, and to the BAA-covered Enterprise account (`ent`) otherwise. The release gate is zero PHI on the wire to a personal account. Four facts make the shape non-obvious:

- `route()` receives a compaction-aware projection of the conversation. Compaction, `/tree` navigation and context edits renumber its messages, so an index cursor (`scannedThrough: number`) can point past content that was never scanned.
- Content reaches models outside `route()`: delegates resolve model aliases to their home provider, the harness compaction calls `complete()` with the selected model, codemode scripts reach classifier and image models, and the claude-accounts failover wraps `ent` back to `ultra-a`.
- A failure anywhere (an image, a blob that won't decode, a Decisions timeout, a bug) must end on `ent`.
- The policy engine must carry no pi imports, so the Claude Code, Codex and OpenCode adapters of phase 5 can call it.

## Usage

The developer selects `phi/auto` once. `~/.pi/agent/phi-router.json` sets the mode; without it the router runs in `shadow`.

```json
{
	"mode": "enforce",
	"model": "claude-opus-5-5",
	"baaRepos": ["/home/me/work/clinic-etl"],
	"fixtures": ["9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"]
}
```

`fixtures` lists the lowercase hex SHA-256 digests of turn parts the scan skips: test data the developer vouches holds no PHI. A part is one message content block, such as a pasted fixture or a tool result that returns a fixture file unchanged, and its digest is that of its exact UTF-8 text (`sha256sum` of the file). The rules and the judge both skip a registered part. One changed character makes it a different part, which is scanned as usual. Exemption is by registered hash only: no rule excuses an identifier for looking like a placeholder, such as `555-0123` or repeated digits, or for sitting near a name such as John Doe. A digest that is not 64 lowercase hex characters makes the file bad settings, which sends every request to `ent`.

An adapter calls the engine with its own transcript and Judge layer:

```ts
const result = yield * scan(transcript, state.cursor).pipe(Effect.provide(decisionsJudge(classify)));
// ScanResult.Clean { cursor } | Tainted { taint } | Unsure { why }
```

owned-work asks the router where a delegate of a `phi` session runs:

```ts
const target = delegateTarget({ parent: ctx.model, branch: ctx.sessionManager.getBranch(), wanted });
// Run("phi/auto"), Run("ent/claude-opus-5-5") once the parent branch is tainted, or Refuse(why)
```

The engine harness:

```sh
bun features/phi-router/corpus/eval.ts <manifest.jsonl> --judge live|recorded
```

It plays each case request by request, as pi sends them when the corpus wire scenario plays the case (`corpus/requests.ts`): the same request boundaries, steering, paged reads, compactions with pi's list of files read, rendered tool calls and tool output. Its judge inputs equal the wire's for every case of the default corpus. The judge needs this: in case h-0148 the wire request scored 0.13 on `patientData`, and the same content as bare manifest messages scored 0.83. A PHI case is a miss when a request whose scan comes back Clean carries one of the case's canary tokens (`canary-tokens.ts`, shared with the wire run), or when no scan ever catches it. Catching the case on a later request does not undo a fragment already sent.

## Shape

`features/phi-router/`:

| File                      | Owns                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy/index.ts`         | The engine's public surface: `Transcript`, `Cursor`, `Taint`, `ScanResult`, the `Judge` service, `scan()`. No pi imports, pinned by `policy/boundary.test.ts`.                  |
| `policy/expand.ts`        | Decoders (base64, gzip, gzip as hex, URL encoding) that turn new turns into text, or into `Unscannable`. See Decoded bytes.                                                     |
| `policy/rules.ts`         | `firstHit()` over the deterministic rules: identifier patterns, record signatures (FHIR, HL7 v2, X12), a name near an address, phone or email.                                  |
| `policy/labelled.ts`      | A field label table per Safe Harbor class, and the patient-side label rule. A labelled value taints alone, and so does a short value after an exact label at the end of a turn. |
| `decisions.ts`            | The `Judge` layer over OpenAI Decisions (`gpt-6-luna`, `/v1/decisions`).                                                                                                        |
| `route.ts`                | `decide()`: reason, mode and stored state to the account, the next state and the lane record.                                                                                   |
| `session.ts`              | pi shapes to domain: `transcriptOf(messages)`, `storedState(branch)`.                                                                                                           |
| `gate.ts`                 | The leak paths outside `route()`: `delegateTarget()`, the codemode guard.                                                                                                       |
| `settings.ts`, `lanes.ts` | The settings file and the lane log.                                                                                                                                             |
| `index.ts`                | Registers `phi/auto` and the codemode guard.                                                                                                                                    |
| `corpus/`                 | Manifest schema, seeded generator, `requests.ts` (the requests pi sends for a case), `eval.ts` CLI, the recorded Decisions answers for stub mode.                               |
| `relabel.ts`              | Phase 3: relabel a sample of would-be-personal requests with a stricter Decisions prompt.                                                                                       |

**Cursor.** `Unscanned | Cleared {system, turns, chain} | Tainted {taint}`. `chain` is a running SHA-256 over the conversation turns already cleared. `turns` is trusted only while the chain over the new transcript's first `turns` turns still equals `chain`; any mismatch rescans the whole conversation (rule 4). Forks and `/tree` read the cursor stored on their own branch, whose transcript extends it. Compaction breaks the chain, so the summary and the kept turns rescan once. The system turns have their own digest, so a changed system prompt is judged again on its own. State stays constant in size.

**Whole-context certification.** The rules run over the whole transcript on every request; they are cheap. The judge gets the new conversation turns as `fresh` and the conversation already cleared as `seen`, so a name cleared long ago and a diagnosis that arrives later are judged together. System turns get a call of their own, with nothing as `seen`, on the first scan and whenever their digest changes; either call tainting latches the session, and either failing is `Unsure`. They are kept out of `seen` because pi's system prompt is about 50,000 characters of harness instructions and project context, and judged beside it a fragment loses its context: a patient export listing cut off at `referrals/NG207` scored 0.04 on `patientData` with pi's prompt in `seen` and 0.36 without it, and reached a personal account at the wire. Rule 5 still holds, because the system turns are judged on the first scan. Content is judged as it arrives, though: a request is sent once its new turns clear, so a record cut off at a message boundary is judged on its first fragment, in the context the session already holds, before the rest exists. The judge's `patientData` question covers that case. It asks whether the fragment is a value from a health organization's records about one patient (a clinical note's header, a rejected claim's log line, a patient export's file listing), cut off or not, so the first fragment latches the session when the session already shows whose data it is. A fragment the session gives no such context for is judged on its own. Decisions' classifier takes about 900k tokens, so `maxChars` is 2,000,000 characters. Each call's input is held to that limit on its own. An input beyond it is never split, because no single piece would hold both the name and the diagnosis: the scan is `Unsure(too-large)`, which sends that request to `ent` without latching, so a later compaction can bring the session back. The cursor still earns its place: it tells the judge what is new and skips the judge when nothing is (a retry resends the same transcript).

**Decoded bytes.** Bytes that are printable UTF-8 are judged as that text. Any other bytes are judged as every reading side by side: UTF-16LE, UTF-16BE and Windows-1252, with NULs dropped and control characters as spaces. No test picks the reading that was meant, because each one tried so far rejected a real note somewhere (mixed scripts, many accents, a trailing NUL) and let a byte-swapped reading speak for it. Bytes of 64 or fewer are always judged this way, so a key or a digest costs a few lines of gibberish rather than a latch. Longer bytes are judged when at least one reading is free of controls (other than NUL, tab, CR and LF), surrogates, private-use and unassigned code points. Then every reading goes, so a true reading that holds a private-use glyph is still seen. When no reading qualifies, the bytes are `Unscannable(binary)`.

**Patient-side labels.** Safe Harbor's last class, any other unique identifying number, characteristic or code, is open-ended, so no list of labels closes it. A label whose first word is a patient-side person (`patient`, `pt`, `member`, `subscriber`, `beneficiary`, `insured`, `guarantor`), followed by any label words in snake_case, kebab-case, camelCase or spaced, taints with a value that holds a digit: `patient_ref_no 12`, `member-alt-key: A123`, `subscriberGroupCode=77Q`, `Insured party number 4471`. A value cut off at the end of a turn counts the same way. A word joined on without a lowercase-to-uppercase step, as in `patients` or `PTSD`, is another word. The rule runs after the label table, so a label the table knows keeps its own class.

**Results.** `Clean` advances the cursor. `Tainted` (PHI by rule or judge, image, binary, undecodable, malformed state) latches the branch for good. `Unsure` (judge error or timeout, a judge input over `maxChars`, engine defect) sends this one request to `ent` and leaves the cursor, so the next request rescans. Both end on `ent`.

**Router state.** `{ cursor, home, limited }`. There is no `lane` field: the lane derives from the cursor. `home` is the personal account the session took at its first request (a hash of the session id spreads sessions over both subscriptions). `limited` stamps when each personal account last answered 429.

**decide().** `direct` goes to `ent`. `force-baa`, or a working folder under a `baaRepos` entry, goes to `ent` without a scan. A Tainted cursor goes to `ent`. Otherwise scan: Tainted or Unsure goes to `ent`; Clean picks the first of `home` and its fallback chain that is not limited, `ent` last. A retry after a personal 429 stamps that account first. A retry after a failure on `ent` stays on `ent`. `shadow` computes all of it, stores the would-be state, logs the would-be account and dispatches `ent`.

**One owner per rule.** `claude-accounts/accounts.ts` gains a `baa` flag per account and `fallbackChain(from)`: the other personal accounts, then the BAA accounts; nothing from a BAA account. The router's account choice and the selection failover both read it, so "ent never falls back to a personal account" lives in one place.

**Leak paths.**

- Protected sessions. A session whose selection is `phi/auto` or a BAA account (`ent/...`) is protected: a latched `phi` session hands its delegates to `ent`, and their own delegates and scripts must stay inside the boundary too.
- Delegates. owned-work resolves every delegate of a protected session through `delegateTarget`. From `phi/auto`: an alias or a personal or `phi` key becomes `phi/auto`, or `ent/<model>` once the parent branch is tainted; a BAA key passes; anything else is refused. From a BAA account: an alias becomes the same model on that account when it has it, else the `phi/auto` model on it; only BAA keys pass. `childExtensions` gains the router so a child can run `phi/auto`.
- Compaction. pi's own compaction and `/tree` summaries route `direct`, so `ent`. The harness compaction moves from `complete()`, which fails on a virtual model, to `streamSimple()`, which routes `direct`.
- Codemode. A `tool_call` guard blocks a codemode script in a protected session when its code, after unicode escapes are decoded, names `models`, `globalThis`, `self`, `Reflect`, `eval`, `Function` or `import(` (classifier and image calls bypass the router). It guards against a model that reaches `models` by accident, not an adversary.
- Failover. `fallbackChain` removes the `ent` to `ultra-a` wrap, for every session.
- Model switches. `/model` and `/account` from a protected selection to an unprotected one, in a session whose branch holds content pi sends (messages, extension messages, summaries), are put back with a notice, since the next request would carry the whole history unrouted. When the previous model cannot be selected again, the session goes to the branch's last protected model, then `phi/auto`, which needs no credential; when none can be selected, the human gets an error. A session resumed with `--model` on an unprotected model, which fires no `model_select`, gets the same check at `session_start`.
- Compaction at send time. pi checks its compaction threshold after `route()` returns and, when the context passes it, compacts and sends the summary to the routed model without routing again. The router dispatches `ent` for any request whose context passes pi's threshold, counted as the larger of pi's own token count and a quarter token per scanned character.

**Lane log.** One JSONL file per session under `~/.local/state/pi-phi-router/lanes/`, since delegates share HOME. Every field is a literal union, a number or an id, so the schema cannot hold content.

## Synthesis decision

Three runners sketched the design: candidate 1 on `judgment`, candidate 2 on `investigator`, candidate 3 on `divergent`. The cross-judge (on `investigator`, the same family as candidate 2) recommended candidate 2, whose router keeps no cursor and certifies the whole context in one judge call on every request. It flagged four real faults in candidate 1: a bounded lookbehind cannot relate a name cleared long ago to a diagnosis that arrives later; unchanged system turns were judged apart from the conversation; a latched session's delegates on `ent` escaped the delegate and codemode guards; and the codemode guard missed `\u006dodels`.

Candidate 1 is still the base, with candidate 2's core idea grafted in. Its digest cursor keeps state constant, the task requires a cursor that survives compaction, forks and `/tree`, the split between a latching taint and a one-request `Unsure` keeps a network blip from costing the session its savings, and its account chain has one owner where candidate 2 keeps the ladder in both the router and the failover. Each fault the judge found is fixed in this design rather than by switching shape.

Grafts:

- From candidate 2: whole-context certification. The judge sees the whole cleared conversation as `seen`, not a tail, and the rules run over the whole transcript each request. This fixes the first fault. The second, judging system turns apart, was later chosen on purpose, because pi's long system prompt dilutes fragment judging (see Whole-context certification and Known limits).
- From the judge: protected sessions cover BAA-account selections as well as `phi/auto`, and the codemode guard decodes unicode escapes first. This fixes the last two.
- From candidate 2: the eval reports misses, uncertain and over-routing apart, so an always-`ent` detector cannot hide its cost.
- From candidate 3: every fail-closed cause is a typed tag (`Unscannable.what`, `Unsure.why`), so the harness can stratify by cause.

Rejected:

- Candidate 1's `phi/<id>` virtual model per Anthropic id. The human asked for `phi/auto`, and `delegateTarget` closes the alias path without a model per id or reading router state across ids.
- Candidate 1's stub judge that answers 0. The stub must let `bun test` assert zero misses, so stub mode replays recorded live Decisions answers by content digest and fails on any unrecorded call.
- Candidate 2's full rescan on every request and judge overflow as `uncertain`. It is the simplest correct shape, but it pays a whole-context Decisions call per request and sends every long session to `ent`.
- Candidate 3's ring of clean hashes in state. It grows the state pi rewrites on every change, and the digest chain is constant in size.
- Candidate 3's provider allowlist for codemode `models` calls. A script's provider is not knowable before it runs.

## Changes to the plan's sketch

1. `scannedThrough: number` became the digest-verified cursor, because indexes shift after compaction and navigation.
2. `uncertain` split into a latching taint (image, binary, undecodable, malformed state) and `Unsure` (judge error or timeout, a judge input over `maxChars`, engine defect), which costs one request on `ent`, not the session. Rule 1 still holds: each goes to `ent`.
3. `lane` left the state. It derives from the cursor.
4. `account` became `home` plus `limited` stamps, ordered by `fallbackChain` from claude-accounts. The account map is that list, not a separate config.
5. The always-BAA repo list moved from the rules to mode resolution, since it is not about content.
6. Missing state starts a fresh full scan rather than routing to `ent`: the first request of every session has none, and a full scan is the "cannot tell what is new" case. Malformed state latches.
7. The judge sees the cleared conversation beside the new turns, and the rules rescan the whole transcript, so a later turn is judged together with everything before it. An earlier fragment is judged when it arrives, in the context the session already holds, and is sent once it clears; the `patientData` question is what catches a value cut off inside a patient record before its health detail arrives.
8. Delegates and codemode are guarded in BAA-account sessions too, so a latched session's delegates cannot leave the boundary.

## Tradeoffs accepted

- We accept a full rescan after compaction or any edited prefix in exchange for constant-size state and no unsafe index.
- We accept that one image, even of code, ends the branch's savings, so pixels are never judged.
- We accept extra judge calls after an `Unsure` in exchange for not latching on a network blip.
- We accept that a delegate from a `phi` session runs on `phi/auto` whatever alias it names, so `investigator` and `divergent` lose their model family there.
- We accept over-blocking codemode scripts that mention `models` in a `phi` session.
- We accept compaction of clean sessions on `ent`.
- We accept that test fixtures with realistic identifiers latch the session unless their exact text is registered under `fixtures`. Code cannot tell a fake identifier from a real one by its shape: a real MRN can hold `222`, and a real patient can be registered as John Doe. On seed 4242 an exemption that tried let `{device_serial=NG222` reach a personal account, because `222` read as a placeholder.
- We accept that a type under a patient-side label, such as `member_id varchar(30)` in a schema, latches the session. The rule takes any value with a digit, because a type and an identifier differ only in how they look.
- We accept a Decisions call over the whole context on each request that adds content, in exchange for judging relationships across the whole conversation. At $0.10 per million input tokens it is small next to the Claude tokens it moves off API pricing; its latency is measured in the eval.

## Alternatives considered

- A local wire proxy in front of all three accounts. It sees exactly what is sent and would serve Claude Code unchanged, but it hides routing from pi: session files name the wrong account, pi's retry cannot see 429s, the proxy holds `ent` credentials, and without session state it rescans every whole body.
- Taint at ingestion, scanning tool results and user input as they enter the session. System prompts, summaries and steering enter through paths with no single hook, and a missed hook leaks silently. Dispatch-time scanning covers whatever pi sends.

## Known limits

- Decoded text in an encoding other than UTF-8, UTF-16 or Windows-1252 (UTF-32, EBCDIC, Shift-JIS, GB18030, KOI8-R and the like) is read only as those three. When one of the three happens to look like text, the judge sees gibberish and the request can go to a personal account.
- UTF-16 text whose bytes also happen to be printable UTF-8 is judged as the UTF-8 reading alone. Spaces and ASCII punctuation in UTF-16 carry a NUL byte, so this needs a run of letters with none.
- Random bytes just over 64 sometimes look like text in one of the readings, and are then judged rather than latched as binary: about 1 in 110 at 66 bytes, 1 in 350 at 80, 1 in 10,000 at 128 and none of 20,000 at 256. Short blobs in formats the engine does not inflate (zlib, raw deflate, zip, encrypted data) fall in that window.
- The gibberish readings of random 64-byte values (keys, SHA-512 digests in bare base64) push the judge over the threshold about one time in ten, which latches the session on `ent`. `sha512-` integrity strings in lockfiles are not decoded, so lockfiles are not affected.
- Redacted thinking is skipped: it is model output derived from content the router already cleared.
- A session whose judge input passes `maxChars` (2,000,000 characters) runs on `ent` for every request that adds content, until a compaction brings it back under the limit.
- A record cut off at a message boundary is sent when its first fragment clears. The `patientData` question catches a fragment when the session already shows patient data; a fragment that arrives with no such context, or one too short for the judge to read as a value, is sent before the rest latches the session. A fragment with a field label for a Safe Harbor identifier latches on its own: the labelled rules taint `Driver license: Z358-827` and `Client IP: 203.0.113.133`, which each leaked once at the wire (`patientData` 0.13 and 0.06), and an exact label such as `MRN` with a value of three or more letters and digits taints at the end of a turn even when the value is shorter than the identifier. A patient-side label taints with any value that holds a digit, cut off or not. An unlabelled fragment still depends on the judge.
- The Decisions questions still tell the judge that well-known placeholder people and values (John or Jane Doe, `555-01xx` phones, `123-45-6789`) are no one, so an unlabelled value beside such a name depends on how the judge reads it. Taking that text out dropped the cut-off file name `referrals/NG207` in case h-0015 from `pPhi` 0.36 to 0.10 in five of five live calls, a miss, so it stays until the questions are tuned again.
- System turns are judged apart from the conversation, so a relation split between them, such as a name only in project context and a diagnosis only in chat, is not judged as one. A live probe with pi's 50,000-character prompt found no leak: a name with a date of birth in project context latches on the date-of-birth rule; a name described as a pilot user from a clinic waitlist latches on the system call alone (`phi` 0.74); and a release owner's name in project context with "the release owner named in AGENTS.md was admitted with a confirmed HIV diagnosis" in chat latches on the chat turn alone (`phi` 0.86). A diagnosis in chat that points at no one in particular would not latch. In the corpus wire run, this harness's system prompt carried no `AGENTS.md` text, so project context reaches the model only through a tool read, a conversation turn; the limit applies where pi injects `AGENTS.md` into the system prompt.
- The eval heads each request with the case's system messages, while the scenario's pi sends its own 50,000-character prompt and no `AGENTS.md`. System turns are judged apart, so only the system call differs. The eval numbers tool calls as the wire's mock does only while every request goes to a personal account; after an Unsure request the wire's ids differ.
- A request near pi's compaction threshold goes to `ent` when the character estimate passes it, even if pi would not compact; the estimate is deliberately the larger of the two counts.

- Bash, MCP servers and other tools can send content anywhere; the router governs model requests only.
- When the router extension fails to load, pi restores a `phi/auto` session on the last account that answered, which may be personal. The router cannot guard a session it is not loaded in.
- `web_search` and `web_fetch` send model-written queries and URLs to Exa, Parallel and target sites. That disclosure is not to a model and exists for `ent` sessions today.
