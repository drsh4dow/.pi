---
status: proposed
---

# Route each request by its content, and latch a branch to the BAA account for good

Most coding sessions carry no PHI, and the personal Claude subscriptions cost far less than the Enterprise account that the Anthropic BAA covers. So `phi/auto` sends a request to a personal account only when a policy engine judges everything it carries clean. Deterministic rules run first and OpenAI Decisions judges the rest. A phi verdict, or content the engine cannot read, latches the branch to `ent` for good. A Decisions error sends that request to `ent` and leaves the branch as it was. The release gate is zero PHI on the wire to a personal account, proved by a scenario that runs the real `pi` against mock endpoints and searches every captured body for planted canaries.

The latch is one way because a request carries the whole conversation. Once PHI is in it, every later request resends it, and a fork from before it is the only clean copy. The judge sees the earlier conversation beside the new turns, so a name cleared long ago and a diagnosis that arrives later are judged together. System turns are judged in a call of their own, because pi's 50k-character system prompt beside a short fragment pulls its score below the threshold. A digest cursor lets the engine skip the judge on a retry and rescan in full after a compaction, a fork or `/tree`.

Exemption is by registered hash only. A turn part whose exact text has a SHA-256 listed under `fixtures` in `~/.pi/agent/phi-router.json` is skipped by the rules and the judge. No rule excuses an identifier otherwise: not a placeholder shape such as repeated digits or a `555-01xx` phone, not a name such as John Doe nearby, and not a failed checksum on a labelled value. Each of those reads a value's shape, and shape cannot tell a fake identifier from a real one: `{device_serial=NG222` reached a personal account because `222` read as a placeholder.

The rules read field labels per Safe Harbor class. The open-ended class, any other unique identifying number or code, is read from whose it is: a label whose first word is a patient-side person (`patient`, `pt`, `member`, `subscriber`, `beneficiary`, `insured`, `guarantor`) taints with any value that holds a digit, such as `patient_ref_no 12` or `subscriberGroupCode=77Q`.

## Considered options

- **Judge each turn alone.** Rejected. PHI split across turns, such as a name in one tool result and a diagnosis in the next, passes.
- **Redact PHI and send the rest to a personal account.** Rejected. A miss in the redactor is a leak on every later request, and a redacted transcript changes what the model sees.
- **Unlatch after compaction drops the PHI.** Rejected for now. It saves money on long sessions but trusts the summary to have dropped everything. Shadow-mode data can reopen it.
- **Pick the account per session, by hand.** Rejected. It depends on someone noticing PHI before it is sent.

## Consequences

- Every path that sends session content to a model must go through the router or to `ent`: delegates, compaction, codemode classifier calls, model switches and account failover. A new such path is a leak until it is closed.
- Each request that adds content costs one Decisions call over the whole context, about 1 s up to 400k characters and about 5 s at 1.6M.
- When the router extension does not load, nothing guards a `phi/auto` session.
- Test fixtures with realistic identifiers latch a session on `ent` unless the developer registers their exact text.
- A fragment that arrives before any health context, such as the first half of a record cut across two tool reads, can be judged clean and sent to a personal account before the rest latches the branch. The corpus wire run measures this.
