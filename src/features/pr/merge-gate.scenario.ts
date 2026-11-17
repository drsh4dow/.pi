import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { entryKind } from "#src/features/owned-work/index.ts";
import { type Run, type Session, scenario } from "#tools/driver/index.ts";

const repository = "drsh4dow/pi-gate-scratch";
const model = "ultra-a/claude-fable-5-2";
const names = ["bash", "codemode", "rebase", "space", "race", "auto"] as const;

interface Pr {
	readonly branch: string;
	readonly url: string;
	readonly number: string;
}

type Prs = Readonly<Record<(typeof names)[number], Pr>>;

const Outcome = Schema.Struct({ verdict: Schema.optionalKey(Schema.Struct({ result: Schema.String })) });
const Details = Schema.Struct({ name: Schema.String, session: Schema.String, outcome: Outcome });
const Wake = Schema.Struct({ customType: Schema.Literal(entryKind), details: Details });
const decodeWake = Schema.decodeUnknownOption(Wake);

const optionalString = Schema.optionalKey(Schema.String);
const Args = Schema.Struct({ command: optionalString, code: optionalString });
const Part = Schema.Struct({ id: optionalString, text: optionalString, arguments: Schema.optionalKey(Args) });
const Parts = Schema.Array(Part);
const Call = Schema.Struct({ message: Schema.Struct({ role: Schema.Literal("assistant"), content: Parts }) });
const ToolMessage = Schema.Struct({ toolCallId: Schema.String, toolName: Schema.String, content: Parts });
const Result = Schema.Struct({ type: Schema.Literal("message"), message: ToolMessage });
const decodeCall = Schema.decodeUnknownOption(Call);
const decodeResult = Schema.decodeUnknownOption(Result);
const textOf = (part: typeof Part.Type) => part.text ?? "";

const wakeNamed = (entries: ReadonlyArray<SessionEntry>, name: string) =>
	Arr.findFirst(entries, (entry) => Option.filter(decodeWake(entry), ({ details }) => details.name === name));

const inputOf = ({ id = "", arguments: input }: typeof Part.Type) => [id, input?.command ?? input?.code ?? ""] as const;

/** The output of the first `tool` call in `session` whose command or script holds `command`. */
const outputOf = (session: Session, tool: string, command: string) => {
	const calls = Arr.getSomes(Arr.map(session.entries, (entry) => decodeCall(entry)));
	const inputs = new Map(Arr.flatMap(calls, ({ message }) => Arr.map(message.content, inputOf)));
	const results = Arr.getSomes(Arr.map(session.entries, (entry) => decodeResult(entry)));
	const holds = (id: string) => Str.includes(command)(inputs.get(id) ?? "");
	const ran = Arr.findFirst(results, ({ message }) => message.toolName === tool && holds(message.toolCallId));

	return Option.map(ran, ({ message }) => Arr.join(Arr.map(message.content, textOf), "\n"));
};

const finished = (run: Run, name: string) =>
	run.waitFor(`the wake of ${name}`, "10 minutes", ({ root, delegates }) =>
		Option.flatMap(wakeNamed(root.entries, name), ({ details }) => {
			const leaf = Arr.findFirst(delegates, ({ id }) => id === details.session);

			return Option.map(leaf, (session) => ({ root, leaf: session }));
		}),
	);

const shell = (run: Run, script: string) => run.exec(["sh", "-c", script]);

const sh = (run: Run, script: string) =>
	Effect.flatMap(shell(run, `set -e; ${script}`), ({ code, output }) =>
		Effect.as(run.check(code === 0, `${script} exits 0 (it exited ${String(code)}: ${output})`), Str.trim(output)),
	);

const inScratch = (run: Run, script: string) => sh(run, `cd scratch; ${script}`);

const opening = (branch: string) =>
	`git checkout -q -B ${branch} origin/main; printf 'a b\\nc\\n' > ${branch}.txt; git add .; git commit -q -m 'add ${branch}'; git push -q origin ${branch}; gh pr create -R ${repository} --head ${branch} --base main --title ${branch} --body 'merge-gate scenario'`;

const open = (run: Run, branch: string) =>
	Effect.map(inScratch(run, opening(branch)), (output): Pr => {
		// Even with -q, git push prints GitHub's hints before gh prints the URL.
		const url = Str.replace(/^[\s\S]*\n/u, "")(output);

		return { branch, url, number: Str.replace(/^.*\/pull\//u, "")(url) };
	});

const opened = (run: Run, tag: string) =>
	Effect.all({
		bash: open(run, `${tag}-bash`),
		codemode: open(run, `${tag}-codemode`),
		rebase: open(run, `${tag}-rebase`),
		space: open(run, `${tag}-space`),
		race: open(run, `${tag}-race`),
		auto: open(run, `${tag}-auto`),
	});

const removal = (branch: string) =>
	`gh pr close ${branch} -R ${repository}; gh api -X DELETE repos/${repository}/git/refs/heads/${branch}`;

const closed = (run: Run, tag: string) =>
	Effect.forEach(names, (name) => Effect.ignore(shell(run, removal(`${tag}-${name}`))));

const view = String.raw`--json state,autoMergeRequest,headRefOid --jq '"\(.state) \(.autoMergeRequest) \(.headRefOid)"'`;
const stateOf = (run: Run, pr: Pr) => sh(run, `gh pr view ${pr.url} ${view}`);

const byNumber = (pr: Pr) => `gh pr merge ${pr.number} -R ${repository} --squash`;
const byUrl = (pr: Pr) => `gh pr merge ${pr.url} --squash`;
const deferredMerge = (pr: Pr) => `gh pr merge ${pr.url} --auto --squash`;
const script = (command: string) => `return (await tools.bash({ command: '${command}' })).output;`;
const noVerdict = (pr: Pr) => ["merge gate: merge refused.", "No verdict is recorded for it.", `reviews "${pr.url}"`];

const prints = (run: Run, where: string, output: Option.Option<string>, expected: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const text = Option.getOrElse(output, () => "nothing: no such tool call found");

		yield* run.say(`${where} printed:\n${text}`);
		yield* run.check(
			Option.isSome(output) && Arr.every(expected, (line) => Str.includes(line)(text)),
			`${where} prints ${Arr.join(expected, " / ")} (it printed ${text})`,
		);
	});

const isIn = (run: Run, pr: Pr, state: string) =>
	Effect.flatMap(stateOf(run, pr), (seen) =>
		run.check(Str.startsWith(state)(seen), `${pr.url} reads ${state}(state autoMergeRequest head: ${seen})`),
	);

const unverified = (run: Run, prs: Prs) =>
	Effect.gen(function* () {
		yield* run.root.prompt(
			`Do both steps below, then end your turn without waiting for anything. Run every command exactly once; never retry it or work around a failure.\n1. Run \`${byNumber(prs.bash)}\` with your bash tool.\n2. Use the delegate tool once with exactly these fields: name "merger 1", role "leaf", model "${model}", goal "Show what gh prints for a merge", and message "Run \`${byNumber(prs.bash)}\` with your bash tool. Then run this codemode script: ${script(byUrl(prs.codemode))} Run each exactly once, never retry or work around a failure, and reply with both outputs verbatim."`,
		);

		const { root, leaf } = yield* finished(run, "merger 1");
		const codemode = outputOf(leaf, "codemode", byUrl(prs.codemode));

		yield* prints(run, "the root's bash", outputOf(root, "bash", byNumber(prs.bash)), noVerdict(prs.bash));
		yield* prints(run, "merger 1's bash", outputOf(leaf, "bash", byNumber(prs.bash)), noVerdict(prs.bash));
		yield* prints(run, "merger 1's codemode", codemode, noVerdict(prs.codemode));
		yield* isIn(run, prs.bash, "OPEN ");
		yield* isIn(run, prs.codemode, "OPEN ");
	});

const verifiersOf = (root: Session) => Option.all(Arr.map(names, (name) => wakeNamed(root.entries, `verify ${name}`)));

const verified = (run: Run, prs: Prs) =>
	Effect.gen(function* () {
		const lines = Arr.map(names, (name) => `name "verify ${name}", reviews "${prs[name].url}"`);

		yield* run.root.prompt(
			`Use the delegate tool six times, once for each line below, each call with exactly these fields: role "leaf", model "${model}", goal "Prove that a verifier leaves a verdict record", message "Reply with exactly this line and nothing else: VERDICT: PASS", and the name and reviews on its line. Then end your turn without waiting for them.\n${Arr.join(lines, "\n")}`,
		);

		const wakes = yield* run.waitFor("the six verifiers' wakes", "10 minutes", ({ root }) => verifiersOf(root));
		const results = Arr.map(wakes, ({ details }) => `${details.name}: ${details.outcome.verdict?.result ?? "none"}`);
		const seen = Arr.join(results, ", ");

		yield* run.say(seen);
		yield* run.check(Arr.every(results, Str.endsWith(": pass")), `every verifier's wake carries a pass (${seen})`);
	});

const pushed = (run: Run, pr: Pr, change: string) =>
	Effect.gen(function* () {
		const head = yield* inScratch(run, `${change}; git push -q --force origin ${pr.branch}; git rev-parse HEAD`);
		const shown = Effect.filterOrFail(stateOf(run, pr), Str.endsWith(` ${head}`));

		yield* Effect.retry(shown, { schedule: Schedule.spaced("2 seconds"), times: 30 });
		yield* run.say(`${pr.url} shows its new head ${head}`);
	});

const mainMoved = (pr: Pr) =>
	`git checkout -q --detach origin/main; echo main > ${pr.branch}-main.txt; git add .; git commit -q -m 'add ${pr.branch}-main'; git push -q origin HEAD:main; git fetch -q origin main; git checkout -q ${pr.branch}; git rebase -q origin/main`;

const spaced = (pr: Pr) =>
	`git checkout -q ${pr.branch}; printf 'a  b\\nc\\n' > ${pr.branch}.txt; git commit -q -a --amend --no-edit`;

const raceShim = (pr: Pr, realGh: string, folder: string, project: string) => `#!/bin/sh
if [ "$1 $2 $3" = "pr merge ${pr.url}" ] && [ -e ${folder}/race.armed ]; then
	rm ${folder}/race.armed
	cd ${project}/scratch && git checkout -q ${pr.branch} && echo raced >> ${pr.branch}.txt && git commit -q -am raced && git push -q origin ${pr.branch}
	head=$(git rev-parse HEAD)
	for _ in $(seq 30); do [ "$(${realGh} pr view ${pr.url} --json headRefOid --jq .headRefOid)" = "$head" ] && break; sleep 2; done
fi
exec ${realGh} "$@"
`;

/** Agents find this gh after the wrapper on PATH, so its push lands after the gate allowed the merge. */
const armed = (run: Run, pr: Pr, realGh: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const folder = Str.replace(/\/home$/u, "")(run.home);
		const project = yield* sh(run, "pwd");

		yield* fs.writeFileString(`${folder}/bin/gh`, raceShim(pr, realGh, folder, project), { mode: 0o755 });
		yield* fs.writeFileString(`${folder}/race.armed`, "");

		return yield* inScratch(run, `git rev-parse ${pr.branch}`);
	});

const raced = (run: Run, pr: Pr, before: string, output: Option.Option<string>) =>
	Effect.gen(function* () {
		const after = yield* inScratch(run, `git rev-parse ${pr.branch}`);
		const seen = yield* stateOf(run, pr);
		const text = Option.getOrElse(output, () => "nothing");

		yield* prints(run, "merger 2's race merge", output, ["Head branch was modified"]);
		yield* run.check(
			!Str.includes("merge gate")(text) && after !== before && seen === `OPEN null ${after}`,
			`GitHub, not the gate, refuses the race, which stays open at the raced head ${after}, not ${before} (it reads ${seen})`,
		);
	});

const landed = (run: Run, pr: Pr, output: Option.Option<string>) =>
	Effect.andThen(prints(run, `merger 2's merge of ${pr.url}`, output, []), isIn(run, pr, "MERGED "));

const mergerTwo = (run: Run, prs: Prs) =>
	Effect.gen(function* () {
		const bashed = Arr.map([prs.rebase, prs.space, prs.race], (pr) => `with bash \`${byUrl(pr)}\``);
		const steps = [`with bash \`${byNumber(prs.bash)}\``, `with codemode: ${script(byUrl(prs.codemode))}`, ...bashed];

		yield* run.root.prompt(
			`Use the delegate tool once with exactly these fields: name "merger 2", role "leaf", model "${model}", goal "Show what gh prints for merges", and message "Run each of these exactly once, in this order, never retrying or working around a failure, then reply with every output verbatim. Before each step after the first, run \`sleep 20\` with bash, since GitHub refuses a merge that follows another too closely. The steps: ${Arr.join(steps, "; ")}; with bash \`${deferredMerge(prs.auto)}\`." Then end your turn without waiting for it.`,
		);

		const { leaf } = yield* finished(run, "merger 2");

		return (tool: string, command: string) => outputOf(leaf, tool, command);
	});

const merged = (run: Run, prs: Prs, raceHead: string) =>
	Effect.gen(function* () {
		const ran = yield* mergerTwo(run, prs);
		const auto = ["merge gate: a deferred merge is refused.", "Wait for the checks"];

		yield* landed(run, prs.bash, ran("bash", byNumber(prs.bash)));
		yield* landed(run, prs.codemode, ran("codemode", byUrl(prs.codemode)));
		yield* landed(run, prs.rebase, ran("bash", byUrl(prs.rebase)));
		yield* prints(run, "merger 2's space merge", ran("bash", byUrl(prs.space)), ["merge refused.", "another patch"]);
		yield* isIn(run, prs.space, "OPEN ");
		yield* raced(run, prs.race, raceHead, ran("bash", byUrl(prs.race)));
		yield* prints(run, "merger 2's auto merge", ran("bash", deferredMerge(prs.auto)), auto);
		yield* isIn(run, prs.auto, "OPEN null ");
	});

const sameView = (run: Run, pr: Pr, realGh: string) =>
	Effect.gen(function* () {
		const wrapped = yield* run.exec([`${run.agentDir}/bin/gh`, "pr", "view", pr.url]);
		const direct = yield* run.exec([realGh, "pr", "view", pr.url]);
		const codes = `${String(wrapped.code)} and ${String(direct.code)}`;

		yield* run.say(`the wrapper's pr view exits ${String(wrapped.code)}:\n${wrapped.output}`);
		yield* run.check(
			wrapped.code === direct.code && wrapped.output === direct.output,
			`the wrapper and the real gh print the same pr view and exit code (${codes}; real gh printed ${direct.output})`,
		);
	});

const stackPin = (run: Run, pr: Pr, realGh: string) =>
	Effect.gen(function* () {
		const humanHome = yield* Config.String("HOME");
		const pinned = `${realGh} stack merge ${pr.number} --yes --squash --match-head-commit 0000000000000000000000000000000000000000`;
		// The human's gh extensions, gh stack among them, live in a data folder the scratch HOME lacks.
		const { code, output } = yield* shell(run, `cd scratch && XDG_DATA_HOME=${humanHome}/.local/share ${pinned}`);

		yield* run.say(`gh stack merge with a pin exits ${String(code)}: ${output}`);
		yield* run.check(
			code !== 0 && Str.includes("unknown flag: --match-head-commit")(output),
			`gh stack merge rejects --match-head-commit (it exited ${String(code)}: ${output})`,
		);
	});

const gated = (run: Run, prs: Prs, realGh: string) =>
	Effect.gen(function* () {
		yield* unverified(run, prs);
		yield* verified(run, prs);
		yield* pushed(run, prs.rebase, mainMoved(prs.rebase));
		yield* pushed(run, prs.space, spaced(prs.space));

		const raceHead = yield* armed(run, prs.race, realGh);

		yield* merged(run, prs, raceHead);
		yield* sameView(run, prs.rebase, realGh);
		yield* stackPin(run, prs.rebase, realGh);
	});

scenario({
	model,
	play: (run) =>
		Effect.gen(function* () {
			const tag = Str.replace(/^.*\/pi-driver\/(?<id>[^/]+)\/home$/u, "$<id>")(run.home);
			const realGh = yield* sh(run, "command -v gh");

			yield* sh(run, `gh repo clone ${repository} scratch -- -q`);
			yield* Effect.flatMap(opened(run, tag), (prs) => gated(run, prs, realGh)).pipe(
				Effect.ensuring(closed(run, tag)),
			);
		}),
});
