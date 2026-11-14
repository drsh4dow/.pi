# Runtime driver

A scenario proves one fact about the pi that agents run on. It runs the real `pi` on your PATH (never this checkout's
dev copy) on this worktree's own `agent/` folder, with your credentials, and with scratch HOME, agent, session and state
folders and a private terminal core. Your own sessions and state folders stay untouched. It costs real model calls, so
nothing runs it for you.

## Run one

```sh
bun features/owned-work/leaf-wake.scenario.ts
```

```
scenario leaf-wake
run /tmp/pi-driver/leaf-wake-20260514-101010-4242
pi 1.5.2 /home/u/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
agent /home/u/.pi-worktrees/harness-12-driver/agent
  6 s  prompt settled
  14 s  found the leaf's wake
{"ref":"delegate-1","kind":"delegate","outcome":{"status":"done","text":"ok"}}
settled done
  14 s  found what the leaf loaded
leaf runs pi 1.5.2 with /home/u/.pi-worktrees/harness-12-driver/agent/extensions/claude-accounts/index.ts ...
pass leaf-wake in 15 s
evidence /tmp/pi-driver/leaf-wake-20260514-101010-4242
```

| Exit | Meaning                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Every check passed.                                                                                                                                                                               |
| 1    | The scenario failed: a `check`, a `waitFor` that timed out, a prompt that never settled, or the root pi dying. The line before `evidence` says which, as `fail <name>: <claim>`.                  |
| 2    | The driver could not build the run (no `pi` on PATH, the terminal core never came up, the root pi never answered or does not run on what the scenario set). Nothing about the harness was tested. |
| 130  | You pressed Ctrl-C.                                                                                                                                                                               |

Every outcome stops the root pi, its delegates and the run's terminal core, and keeps the run folder as evidence:
`report.txt` (everything printed), `sessions/` (the root's and every delegate's session file), `probe/` (what each pi
loaded and the payloads it built), `root.in.jsonl` and `root.out.jsonl` (every RPC record sent and received), `root.stderr`, `core.log`,
and `home/` (the scratch HOME, including any state folder an agent made). The link to your `auth.json` is removed. A
run killed outright cleans up the same way: the root pi exits when its stdin closes, and the shell that watches the
terminal core stops it with its delegates and removes the link once the driver's pipe closes. That shell starts before
the link exists, so a kill at any moment leaves only the run folder.

To prove a run left your sessions and state folders alone, check it:

```sh
bun tools/driver/untouched.ts features/owned-work/leaf-wake.scenario.ts
```

It lists every session file (`*.jsonl`) under `~/.pi/agent/sessions/` and every file under `~/.local/state/pi-agent/`
before and after the run, with its size and change time, and prints each new, changed or deleted file. Your own sessions
keep writing meanwhile, so a session file whose header names a session that no pi of the run ran, by the run's probe
records, is cleared. Every other change counts against the run, however it was made. It exits 0 when nothing counts
against the run, 1 when something does, and 2 when it cannot vouch (no `evidence` line, or a session of the run the
probe never recorded). A change by one of your agents to its state folder during the run counts against the run too, so
run it while they are quiet. The report also lands in the run's `untouched.txt`.

It cannot see a file the run created and removed again before the second listing, a change to a session file of a
session the probe did not record, the other files in the sessions folder (such as an agent's watch logs, which change
whenever a watch prints), or anything outside those two folders.

## Write one

A scenario is a file named `<fact>.scenario.ts` beside the code whose runtime behavior it proves. It calls `scenario`
once. The lint lets only `*.scenario.ts` files import the driver, and lets nothing import a scenario, so `bun test`
can never run one.

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { scenario } from "../../tools/driver/index.ts";

scenario({
	model: "ultra-a/claude-fable-5-2",
	play: (run) =>
		Effect.gen(function* () {
			const reply = yield* run.root.prompt("Reply with the single word ok.");

			yield* run.check(Option.contains(reply, "ok"), "the root replies ok");
		}),
});
```

The run's name is the file name without `.scenario.ts`.

### What a run gives you

- `run.root.prompt(message, within?)` sends a prompt to the root and waits until pi settles: no retries, compaction
  or queued messages left. It returns the root's last assistant text, or none. A wake from a delegate arrives later as
  a turn of its own, so wait for it with `waitFor`. Default `within` is 10 minutes.
- `run.root.output` is the root pi's stderr so far.
- `run.waitFor(what, within, find)` reads the root's and every delegate's session once a second until `find` returns
  `Option.some(value)`, and returns the value. It fails with `timed out after <within> waiting for <what>`, and fails
  at once if the root pi exits. Use it for every read: pi writes session files as it goes.
- `run.exec(["hc", "ls"])` runs a command with the run's environment: the run's terminal core, scratch HOME and agent
  folder, and the same `pi`. It returns `{ code, output }`. Never spawn a process yourself; it would reach your own
  terminal core and folders.
- `run.say(value)` prints a line to the output and `report.txt`. A string prints as is, any other JSON value as one
  line of JSON.
- `run.pi` is `{ version, path }` of the pi every agent in the run executes. `run.agentDir` is the worktree's
  `agent/`. `run.home` is the scratch HOME: an agent's `~/.local/state/pi-agent/<project>/<work>` is
  `${run.home}/.local/state/pi-agent/<project>/<work>`.
- `run.check(condition, claim)` fails the scenario with `claim` when `condition` is false. Write the claim as the
  fact you expect, with the value you saw, as in `` `the leaf settled done (it settled ${status})` ``.
- `play` may also use Effect's `FileSystem` and `Path`. It gets no process spawner, so `run.exec` is the only way to
  start a command.

A session is `{ id, file, entries, loaded, requests }`. `entries` are pi's `SessionEntry` values, header left out.
`sessions.root` is the root's; `sessions.delegates` holds every delegate's at any depth, oldest first. Decode the
entries you assert on with a `Schema` whose literals come from the feature that writes them, such as `entryKind` from
`features/owned-work/recorded.ts`, so a change to the shape breaks the scenario at compile time or as a timeout that
names it.

The other two fields come from a probe extension the run's `pi` wrapper loads into every pi, delegates included:

- `loaded` is `Option<{ version, model, contextWindow, extensions, settings, modelsError, socket }>`: the running pi's
  own version, its `provider/id`, its context window after your overrides, the extension files that registered a tool
  or a command, links resolved, the settings it runs on, why it dropped `models.json` if it did, and the terminal core
  it starts delegates in. It is recorded at the session's start and again at each agent start, and the latest wins: an
  extension that registers its tools in its own `session_start` handler, such as owned-work, shows from the first
  prompt on.
- `requests` holds the text of every provider payload the session built, oldest first: every string in the payload,
  one per line. Search it with `includes`, as in a marker line of a brief or an owner rule. The probe loads first, so
  it records each payload before any other extension's `before_provider_request` handler, which may still change or
  drop text before it reaches the provider. A fact about what was sent after such a handler needs its own probe.

### Setup

The other keys of the object change the run's world before the root starts. Every pi in the run, delegates
included, sees them.

- `model` is the root's `provider/id`. It is required, so every scenario states what it spends.
- `settings` replaces top-level keys of the run's copy of your `settings.json`. The copy never holds your
  `packages`, `extensions`, `skills`, `prompts` or `themes`, so nothing of the live harness loads into a run.
- `models` holds provider entries by name, as in `models.json`'s `providers` (fields in pi's
  `docs/models-configuration.md`, `modelOverrides` included). Each replaces your entry of that name in the run's copy
  of your `models.json`, or starts the file if you have none. pi in RPC mode drops a `models.json` it rejects
  without a word and runs on without your entries.

- `contextWindow` forces compaction in a few turns. It gives the root's model a window of that many tokens and
  replaces your compaction settings, which may reserve more than the whole window, with a reserve of a quarter of it,
  so pi compacts once a session passes three quarters:

```ts
scenario({
	model: "ultra-a/claude-fable-5-2",
	contextWindow: 40_000,
	play: (run) => ...,
});
```

`tools/driver/compaction.scenario.ts` proves it: three prompts of filler, then a compaction entry in the root's session.

Before `play` runs, the driver reads what the root's pi runs on and exits 2, naming each miss, unless it runs the
`model`, the `contextWindow`, every `settings` key you set, a `models.json` pi kept, and the run's own terminal core.

### Examples

- `tools/driver/smoke.scenario.ts`: the run uses pi 1.5.2, the worktree's extensions, and the context window `contextWindow` sets.
- `tools/driver/compaction.scenario.ts`: `contextWindow` makes pi compact.
- `features/owned-work/leaf-wake.scenario.ts`: the root starts a leaf and wakes with its result, and the leaf runs the
  same pi on the worktree's extensions.
- `tools/driver/false-fact.scenario.ts`: a false claim exits 1.
