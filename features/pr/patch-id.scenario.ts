import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Run, scenario } from "../../tools/driver/index.ts";
import { entryKind } from "../owned-work/index.ts";
import { VerdictRecord, verdictsFolder } from "./index.ts";

const repository = "drsh4dow/pi-gate-scratch";

const model = "ultra-a/claude-fable-5-2";

const Verdict = Schema.Struct({ pr: Schema.String, head: Schema.String, result: Schema.String });

const Delegate = Schema.Struct({
	kind: Schema.Literal("delegate"),
	name: Schema.String,
	session: Schema.String,
	outcome: Schema.Struct({ status: Schema.String, verdict: Verdict }),
});

const Wake = Schema.Struct({
	type: Schema.Literal("custom_message"),
	customType: Schema.Literal(entryKind),
	details: Delegate,
});

const decodeWake = Schema.decodeUnknownOption(Wake);

const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(VerdictRecord));

const wakeNamed = (entries: ReadonlyArray<SessionEntry>, name: string) =>
	Arr.findFirst(entries, (entry) => Option.filter(decodeWake(entry), ({ details }) => details.name === name));

const mustRun = (run: Run, argv: readonly [string, ...Array<string>]) =>
	Effect.flatMap(run.exec(argv), ({ code, output }) =>
		Effect.as(
			run.check(code === 0, `${Arr.join(argv, " ")} exits 0 (it exited ${String(code)}: ${output})`),
			Str.trim(output),
		),
	);

const git = (run: Run, ...args: ReadonlyArray<string>) => mustRun(run, ["git", "-C", "scratch", ...args]);

const branchWithFile = (run: Run, branch: string, from: string) =>
	Effect.gen(function* () {
		yield* git(run, "checkout", "-q", "-B", branch, from);
		yield* mustRun(run, ["sh", "-c", `echo ${branch} > scratch/${branch}.txt`]);
		yield* git(run, "add", ".");
		yield* git(run, "commit", "-q", "-m", `add ${branch}`);
		yield* git(run, "push", "-q", "origin", branch);
	});

const openPullRequest = (run: Run, branch: string, base: string) =>
	mustRun(run, [
		"gh",
		"pr",
		"create",
		"-R",
		repository,
		"--head",
		branch,
		"--base",
		base,
		"--title",
		branch,
		"--body",
		"patch-id scenario",
	]);

/** The command the gate runs, here from the root's project folder, which is no repository. */
const patchIdOutside = (run: Run, pr: string) =>
	Effect.map(mustRun(run, ["sh", "-c", `gh pr diff "$1" | git patch-id --verbatim`, "sh", pr]), (line) =>
		Arr.headNonEmpty(Str.split(line, " ")),
	);

const verify = (run: Run, pr: string, name: string) =>
	Effect.gen(function* () {
		yield* run.root.prompt(
			`Use the delegate tool once with exactly these fields: name "${name}", role "leaf", model "${model}", goal "Prove that a verifier leaves a verdict record", reviews "${pr}", and message "Reply with exactly this line and nothing else: VERDICT: PASS". Then end your turn without waiting for it.`,
		);

		const wake = yield* run.waitFor(`the wake of ${name}`, "5 minutes", ({ root }) => wakeNamed(root.entries, name));

		yield* run.say(wake.details);

		return wake.details;
	});

const recordsOf = (run: Run, number: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const folder = `${verdictsFolder(run.home)}/${repository}/${number}`;
		const names = yield* Effect.orDie(fs.readDirectory(folder));
		const files = Arr.filter(names, Str.endsWith(".json"));

		return yield* Effect.forEach(files, (file) =>
			Effect.orDie(Effect.flatMap(fs.readFileString(`${folder}/${file}`), decodeRecord)),
		);
	});

const headOf = (run: Run, pr: string) =>
	mustRun(run, ["gh", "pr", "view", pr, "--json", "headRefOid", "--jq", ".headRefOid"]);

const numberOf = (url: string) => Str.replace(/^.*\/pull\//u, "")(url);

interface Branches {
	readonly bottomBranch: string;
	readonly topBranch: string;
}

interface Stack extends Branches {
	readonly bottom: string;
	readonly top: string;
}

const stackOf = (run: Run, { bottomBranch, topBranch }: Branches) =>
	Effect.gen(function* () {
		yield* mustRun(run, ["gh", "repo", "clone", repository, "scratch", "--", "-q"]);
		yield* branchWithFile(run, bottomBranch, "origin/main");
		yield* branchWithFile(run, topBranch, bottomBranch);

		const bottom = yield* openPullRequest(run, bottomBranch, "main");
		const top = yield* openPullRequest(run, topBranch, bottomBranch);
		const stack: Stack = { bottomBranch, topBranch, bottom, top };

		return stack;
	});

/** Closes what the run opened by branch name, so it also cleans up after a run that failed halfway. */
const closed = (run: Run, { bottomBranch, topBranch }: Branches) =>
	Effect.forEach([topBranch, bottomBranch], (branch) =>
		Effect.all([
			Effect.ignore(run.exec(["gh", "pr", "close", branch, "-R", repository])),
			Effect.ignore(run.exec(["gh", "api", "-X", "DELETE", `repos/${repository}/git/refs/heads/${branch}`])),
		]),
	);

/** Merges the bottom pull request, rebases the top one onto main, and waits until GitHub shows the new head. */
const mergeAndRebase = (run: Run, { bottomBranch, topBranch, bottom, top }: Stack) =>
	Effect.gen(function* () {
		yield* mustRun(run, ["gh", "pr", "merge", bottom, "--squash"]);
		yield* git(run, "fetch", "-q", "origin", "main");
		yield* git(run, "rebase", "-q", "--onto", "origin/main", bottomBranch, topBranch);
		yield* git(run, "push", "-q", "--force", "origin", topBranch);
		yield* mustRun(run, ["gh", "pr", "edit", top, "--base", "main"]);

		const head = yield* git(run, "rev-parse", topBranch);
		const shown = Effect.filterOrFail(headOf(run, top), (seen) => seen === head);

		return yield* Effect.retry(shown, { schedule: Schedule.spaced("2 seconds"), times: 30 });
	});

const pinned = (records: ReadonlyArray<VerdictRecord>, session: string, head: string, patchId: string) =>
	Arr.some(
		records,
		(record) => record.verifier.session === session && record.head === head && record.patchId === patchId,
	);

const carried = (run: Run, stack: Stack) =>
	Effect.gen(function* () {
		const before = { id: yield* patchIdOutside(run, stack.top), head: yield* headOf(run, stack.top) };
		const first = yield* verify(run, stack.top, "verify top before");
		const after = { head: yield* mergeAndRebase(run, stack), id: yield* patchIdOutside(run, stack.top) };
		const second = yield* verify(run, stack.top, "verify top after");
		const records = yield* recordsOf(run, numberOf(stack.top));

		yield* run.say({ before, after, records });
		yield* run.check(
			before.id === after.id && before.head !== after.head,
			`the top pull request's patch-id from outside the repository is equal across the merge and rebase (${before.id} at ${before.head}, ${after.id} at ${after.head})`,
		);
		yield* run.check(
			first.outcome.verdict.result === "pass" && second.outcome.verdict.result === "pass",
			`both wakes carry a pass (${first.outcome.verdict.result}, ${second.outcome.verdict.result})`,
		);
		yield* run.check(
			records.length === 2 &&
				pinned(records, first.session, before.head, before.id) &&
				pinned(records, second.session, after.head, after.id),
			`each verifier left one record pinning its head and the patch-id the command gives (${String(records.length)} records)`,
		);
	});

scenario({
	model,
	play: (run) =>
		Effect.gen(function* () {
			const outside = yield* run.exec(["git", "rev-parse", "--is-inside-work-tree"]);

			yield* run.check(
				outside.code !== 0,
				`the root's project folder is no repository (git said ${outside.output})`,
			);

			const tag = Str.replace(/^.*\/pi-driver\/(?<id>[^/]+)\/home$/u, "$<id>")(run.home);
			const branches = { bottomBranch: `${tag}-bottom`, topBranch: `${tag}-top` };

			yield* Effect.flatMap(stackOf(run, branches), (stack) => carried(run, stack)).pipe(
				Effect.ensuring(closed(run, branches)),
			);
		}),
});
