---
status: proposed
---

# A protected delegate keeps its table model

A delegate of a `phi/auto` session ran on `phi/auto` whatever alias or model it named, and `phi/auto` always dispatched `settings.model`, Opus by default. A delegate of a held or `ent` parent fell back to `ent/<settings.model>` when `ent` lacked the id, and nothing said so. So `fable`, `investigator` and `divergent` all became Opus. The model choice and the account choice were one decision in three places: the delegate gate, the dispatch, and the border, which guarded only the Claude personal accounts and so made the gate refuse `openai` and `opencode-go`.

So the alias or the spelled key now picks the model id, and the content of each request picks only the account. The router registers `phi/auto` and one `phi/<id>` for each model id the alias table names, at load, all on one `route()`. A clean request tries the home account, then the other personal providers in order (`ultra-a`, `ultra-b`, `openai`, `opencode-go`), and takes the first that has the id. When none does, or when the request is sealed, it runs the sealed lane: `ent/<id>` when `ent` carries the id, else `ent/<settings.model>`, the named substitute. A delegate of a routing parent runs `phi/<id>`. A delegate of a held or `ent` parent runs the sealed lane, and its tool result carries a `substituted` sentence when the whole run lands on the substitute. The border now also guards `openai` and `opencode-go`. It wraps the provider the registry holds at `session_start` and again before each agent run, unwrapping its own earlier guard first, and it leaves `classify` raw, so the OpenAI Decisions judge reads raw content.

## Considered options

- **One virtual model, with the wanted id in an environment variable or the router's state.** Rejected. The selection would not name the model, so its limits and thinking levels would stay Opus's, and a resumed session would lose the id.
- **A `phi/<id>` for every model id a personal provider carries.** Rejected. It adds dozens of `/model` entries that no delegate routes to.
- **Copy the builtin `openai` and `opencode-go` providers at load and register the guarded copy.** Rejected. The prototype showed that the copy replaces pi's remote catalog and drops catalog-only models in every process, protected or not: `openai` went from 45 models to 44 and `opencode-go` from 34 to 32. The provider the registry holds at `session_start` keeps them.
- **Treat an `ent` parent like a held parent.** Rejected. A spelled personal or `phi` key from an `ent` parent would then run on `ent`, which turns refusals that pass today into runs. An `ent` session never routes, so its delegate keeps refusing those keys.

## Consequences

- `/model` lists four more entries under `phi`: `phi/claude-opus-5-5`, `phi/gpt-6.1-sol`, `phi/claude-fable-5-2` and `phi/glm-5.3-flash`.
- OpenAI counts as a personal provider until the human decides otherwise. Clean content of a `phi/gpt-6.1-sol` request goes to `openai` behind the border.
- A sealed request of a `phi/<id>` whose id `ent` lacks runs on `ent/<settings.model>` for that one request, so it starts with no prompt cache there. The status line, the lane log and the assistant message name the substitute.
- A reply that `openai` or `opencode-go` wrote behind the border counts as a personal reply. Rules alone judge it, and it keeps its thinking.
- ADR 0013 said the border guards only the Claude personal accounts, and ADR 0015 said a switch to another provider carries everything. Both now hold only for providers outside the personal providers.
- `openai` and `opencode-go` get no 429 stamp, so a 429 there never moves a request to another provider. Each alias names one of them, and pi retries.
- The phi-router entry file imports owned-work's `delegateModelIds`, so the alias table stays the one list of ids.
- Another extension that registers `openai` or `opencode-go` in the middle of an agent run drops the guard until the next run starts. No extension in the harness does that.
