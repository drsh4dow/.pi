---
status: proposed
---

# Compaction writes its own summary, and the summary carries the guides that were in context

A compaction drops every guide body the agent had read, and nothing put them back. The retro replayed the loaded feature's in-context check over two 24-hour sessions with 507 delegates. It found 188 guides in context before 11 root compactions and 1 after, and 861 before 54 delegate compactions and 15 after. Root A ran about 13.8 hours with 0 or 1 guide in context. A "reload after compaction" line at the top of `STATE.md` failed at the next compaction in both sessions. pi's own summary prompt also carries every earlier summary into the next ("PRESERVE all existing information from the previous summary"), and Root A's summary grew from 27,134 to 193,845 characters.

So the harness writes the summary itself. One `session_before_compact` handler, in the root and in every delegate, returns the compaction. Its summary carries the bodies of the guides that were in context before the compaction, read from their files at that moment, so a guide edited since the agent read it comes back as it stands now. The loaded feature must recognise that restored text as the guide even when the file changed after the session began, so the context label shows it as loaded and the next compaction finds it in context. The change that builds the restore proves this with a run. The summary is part of the session's projection after the compaction, so the guides reach the next model call however the compaction started. The loaded feature reads summaries, so it counts them as in context.

pi keeps the most recent messages after a compaction. A guide whose body is still in them counts as in context, so the summary neither restores nor lists it. The other guides return in the order the agent first loaded them, up to a budget. The rest are listed by path with a line telling the agent to read them again, and the context label shows them as not loaded. First-loaded order needs no ranking, and the label never claims a guide the model cannot see.

Besides the guides, the summary carries one document whole, its anchor. A root's anchor is its `STATE.md`, and a delegate's is its task message. A root without a state folder has no anchor, and its summary carries the narrative and the guides only. Its narrative keeps the goal, the constraints in force, the open work and the next steps. It drops finished history, which stays in `decisions.tsv` for a root and in the session file for a delegate, so the summary no longer grows with each compaction.

It has to be one handler. For `session_before_compact` the last handler that returns a result wins, so a second handler that restored guides would override the one that writes the summary, or be overridden by it.

## Considered options

- **Send the bodies as a message from `session_compact`.** Rejected. An automatic compaction runs inside an active run, so the message becomes a steer, and the trace of pi 1.5.2 found paths where it goes wrong. On a compaction between turns, a steer already pending makes pi skip its re-poll, and the bodies arrive one turn late. For a virtual model, the compaction inside request preparation runs after the poll, so that call misses them. After the run's last response, the steer costs a model turn the run would not have taken, and a queued wake reaches the agent only after the model replies to the bodies. Sending without a turn, or for the next turn, misses the model in more of these cases.
- **Prepend the bodies on every request through the `context` event.** It runs inside every request, so it would reach the model after every kind of compaction. Rejected. It persists nothing, so the context label, which ADR 0003 computes from the session's projection, would show none of the guides the model sees. Its coverage of every request path is also unproven for virtual models.

## Consequences

- A summary that restores guides costs about 20,000 to 30,000 tokens of guide bodies, by the design's estimate. The guide budget caps it.
- The harness owns the summary prompt and its quality, and pi's "PRESERVE all existing information" prompt stops running.
- Every compaction of a root with a state folder carries `STATE.md` whole, so its size costs context at each compaction, and the state-folder checks bound it.
- The root prompt's line telling the agent to read `STATE.md` after a compaction goes, since the summary carries the file.
- A hook's result makes pi drop the read and modified file lists from the compaction, so the handler carries them itself.
- When the summary call fails, the handler writes a deterministic summary. Falling back to pi's default would restore no guides for that compaction.
- Delegates load the handler too, though today they load only the owned-work, prompt, web and claude-accounts extensions.
