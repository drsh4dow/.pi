---
status: proposed
---

# A protected delegate keeps its table model

A delegate of a `phi/auto` session ran on `phi/auto` whatever alias or model it named, and `phi/auto` always dispatched `settings.model`, Opus by default. A delegate of a held or `ent` parent fell back to `ent/<settings.model>` when `ent` lacked the id, and nothing said so. So `fable`, `investigator` and `divergent` all became Opus. The model choice and the account choice were one decision in three places: the delegate gate, the dispatch, and the border. The human also ruled that "openai chat models can handle sealed content", so OpenAI may receive PHI as `ent` does.

So the alias or the spelled key now picks the model id, and the content of each request picks only the provider that runs it. The BAA providers are `ent` and `openai`, in that order. The personal providers are `ultra-a`, `ultra-b` and `opencode-go`, and the border guards only them. The router registers `phi/auto` and one `phi/<id>` for each model id in the alias table that a personal provider carries, at load, all on one `route()`. A clean request tries the home account, then the other personal providers in order, and takes the first that has the id. When none does, or when the request is sealed, it runs the sealed lane: the first BAA provider that carries the id, else `ent/<settings.model>`, the named substitute.

A delegate of a routing parent runs `phi/<id>` when a personal provider carries the id. When none does, it runs directly on the id's sealed lane, with no `phi` model and no judge calls, so `investigator` runs `openai/gpt-6.1-sol`. An alias from a held or BAA parent runs on the sealed lane too. A delegate's tool result carries a `substituted` sentence when the whole run lands on the substitute. A session on `openai` is protected by its selection, as an `ent` session is, so it never routes and its delegates follow the same gate as an `ent` parent's. The border leaves `openai` unwrapped, and the OpenAI Decisions judge on it reads raw content as before.

## Considered options

- **Keep OpenAI a personal provider behind the border.** Rejected by the human's ruling. It needed a guard around `openai`, the provider the Decisions judge calls, and it sent every sealed `gpt-6.1-sol` request to Opus.
- **One virtual model, with the wanted id in an environment variable or the router's state.** Rejected. The selection would not name the model, so its limits and thinking levels would stay Opus's, and a resumed session would lose the id.
- **A `phi/<id>` for every model id in the alias table.** Rejected. No personal provider carries `gpt-6.1-sol`, so `phi/gpt-6.1-sol` would send every request to the sealed lane and still judge the new content of each one.
- **A `phi/<id>` for every model id a personal provider carries.** Rejected. It adds dozens of `/model` entries that no delegate routes to.
- **Copy the builtin `opencode-go` provider at load and register the guarded copy.** Rejected. The prototype showed that the copy replaces pi's remote catalog and drops catalog-only models in every process, protected or not: `opencode-go` went from 34 models to 32. The provider the registry holds at `session_start` keeps them.
- **Treat a BAA parent like a held parent.** Rejected. A spelled personal or `phi` key from an `ent` or `openai` parent would then run on the sealed lane, which turns refusals that pass today into runs. A BAA session never routes, so its delegate keeps refusing those keys.

## Consequences

- `/model` lists three more entries under `phi`: `phi/claude-opus-5-5`, `phi/claude-fable-5-2` and `phi/glm-5.3-flash`. Each takes its limits and thinking levels from the catalog model of a personal provider.
- OpenAI is a BAA provider by the human's ruling. `investigator` runs `openai/gpt-6.1-sol` in every standing, sealed content included. A delegate of an `openai` parent runs the sealed lane, so its `judgment` runs `ent/claude-opus-5-5`.
- A reply that `openai` wrote is no longer a personal reply, because it may have read sealed content. The judge reads it, and its thinking is stripped before a personal provider sees it.
- A sealed request of `phi/glm-5.3-flash` runs on `ent/<settings.model>` for that one request, because no BAA provider carries `glm-5.3-flash`. It starts with no prompt cache there. The status line, the lane log and the assistant message name the substitute.
- ADR 0013 said the border guards only the Claude personal accounts, and that a path to a non-Claude provider leaks. The border now also guards `opencode-go`, and a path to `openai` stays inside the BAA boundary.
- `opencode-go` gets no 429 stamp, so a 429 there never moves a request to another provider. One alias names it, and pi retries.
- The phi-router entry file imports owned-work's `delegateModelIds`, so the alias table stays the one list of ids.
- Another extension that registers `opencode-go` in the middle of an agent run drops the guard until the next run starts. No extension in the harness does that.
