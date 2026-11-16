---
status: proposed
supersedes: 0012
---

# Seal the message, not the session, and guard the personal accounts where the bytes leave

ADR 0012 latched a branch to `ent` for good once any request in it carried PHI. A replay of 635 real sessions with per-message sealing in place of the latch moved 72.4% of the `ent` spend to the personal subscriptions. Judge cost cut that to 61.0% net, because the judge saw the whole cleared conversation on every request. The goal is 80% net. The human agreed a narrower policy in `plan-v2.md`. Only a complete direct identifier of a real patient or member seals content. Internal ids, health facts tied to an internal id, schema, staff contacts, fragments and counts do not.

So `phi/auto` decides per request, from that request's new content only. Rules for unambiguous identifiers run first, and OpenAI Decisions judges each new message once, with at most a small window of preceding items and its images. Verdicts are cached by content hash in the session file. A request whose new content holds a sealed message goes to `ent`. Later requests go back to a personal account, with each sealed message replaced by a constant stub. Replies a personal account wrote skip the judge, because every byte that produced them had cleared. Rules still run on them. The system prompt is judged once per digest and never seals a session. `direct` summary requests always go to `ent`, and pi awaits the router's `session_compact` handler, so the summary is judged before any send.

Dropping the latch puts a sealed message in the history of requests bound for `ultra`. The router's dispatch alone cannot be trusted with that. claude-accounts therefore wraps the personal accounts' stream functions with a border. In a process whose session selected `phi/auto`, the border passes only parts whose content hash the router cleared, stubs the rest, and refuses a request whose tool list never cleared. A prototype showed that this is the only hook that sees every byte bound for one account, including summary requests and send-time compaction, and that it held with the router bypassed. Extensions share no module state, so the router hands its verdict lookup to claude-accounts over `pi.events`.

## Considered options

- **Keep the latch, with a narrower policy.** Rejected. Sessions that touch PHI once would still pay `ent` prices for every later request.
- **The border classifies outgoing content and redirects to `ent` itself.** Rejected. It puts a second decision point and an asynchronous handoff inside the transport, and it needs a verdict database with leases. The design's synthesis decision has the comparison.
- **Judge the whole context once per request.** Rejected. That is what cost $322.78 in the replay.
- **Write summaries of clean sessions on `ultra`.** Rejected. `route()` never sees the transcript a summary request carries.
- **Redact identifiers and send the rest.** Still rejected, as in 0012. A redactor miss leaks on every later request.

## Consequences

- The border's guarantee covers dispatch errors, never judge errors. A judge that clears PHI leaks, and only the corpus leak gate measures that.
- Each message is judged alone, so an identifier split across a message boundary, each half a fragment, can reach a personal account in two messages. The human accepted this risk on 2026-11-16: "i accept that risk of cut messages, that is enough defensible legal argument". The leak gate reports such splits and does not fail on them. A complete identifier in any one message still fails it.
- A session that keeps reading real patient records bounces between lanes, and each bounce pays a cold `ent` cache write. `/phi pin` keeps such a session on `ent`.
- Every compaction in a `phi/auto` session runs on `ent`.
- An edit by a `context` hook, or `blockImages`, makes the edited message unknown to the border, so it is stubbed on `ultra`. The lane log counts these.
- A new path that sends session content to a non-Claude provider is still a leak until it is closed. The border guards only the Claude personal accounts.
