---
name: deep-research
description: "A question needs many sources: comparing tools, surveying options, or tracing a behavior across docs, code and issues."
---

# Deep research

1. **Split the question** into 2 to 5 sub-questions that can be answered on their own. Name the versions, platforms and dates that change the answer.
2. **Start one delegate per sub-question**, with `instructionsFile: ~/.pi/agent/instructions/researcher.md`. Write each task message so it stands alone: the sub-question, why it matters, and what to leave out.
3. **Group them** with mode `all`, and end your turn. One wake brings every report.
4. **Synthesize.** Where reports disagree, or a claim decides the answer, `read` the saved page the report cites and check it says what the report says.
5. **Answer** with each claim's URL, the conflicts between sources, and the gaps. A search that found nothing shows only what those queries found.

For a single fact, skip this and use `web_search` and `web_fetch` yourself.
