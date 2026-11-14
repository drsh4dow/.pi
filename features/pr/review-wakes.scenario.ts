import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { type Run, scenario } from "../../tools/driver/index.ts";
import { entryKind } from "../owned-work/index.ts";

const repository = "drsh4dow/pi-gate-scratch";

const Outcome = Schema.Struct({
	status: Schema.String,
	exit_code: Schema.optionalKey(Schema.Finite),
	tail: Schema.optionalKey(Schema.String),
});

const Wake = Schema.Struct({
	type: Schema.Literal("custom_message"),
	customType: Schema.Literal(entryKind),
	details: Schema.Struct({ kind: Schema.Literal("watch"), outcome: Outcome }),
});

const decodeWake = Schema.decodeUnknownOption(Wake);

const watchWakeIn = (entries: ReadonlyArray<SessionEntry>) =>
	Arr.findFirst(entries, (entry) => Option.map(decodeWake(entry), ({ details }) => details.outcome));

const mustRun = (run: Run, argv: readonly [string, ...Array<string>]) =>
	Effect.flatMap(run.exec(argv), ({ code, output }) =>
		Effect.as(
			run.check(code === 0, `${Arr.join(argv, " ")} exits 0 (it exited ${String(code)}: ${output})`),
			Str.trim(output),
		),
	);

const openPullRequest = (run: Run, branch: string) =>
	Effect.gen(function* () {
		yield* mustRun(run, ["git", "-C", "scratch", "checkout", "-q", "-B", branch, "origin/main"]);
		yield* mustRun(run, ["sh", "-c", `echo ${branch} > scratch/${branch}.txt`]);
		yield* mustRun(run, ["git", "-C", "scratch", "add", "."]);
		yield* mustRun(run, ["git", "-C", "scratch", "commit", "-q", "-m", `add ${branch}`]);
		yield* mustRun(run, ["git", "-C", "scratch", "push", "-q", "origin", branch]);

		return yield* mustRun(run, [
			"gh",
			"pr",
			"create",
			"-R",
			repository,
			"--head",
			branch,
			"--title",
			branch,
			"--body",
			"pr-wait scenario",
		]);
	});

const untilFirstReading = Effect.sleep("20 seconds");

const numberOf = (url: string) => Str.replace(/^.*\/pull\//u, "")(url);

scenario({
	model: "ultra-a/claude-fable-5-2",
	play: (run) =>
		Effect.gen(function* () {
			const tag = Str.replace(/^.*\/pi-driver\/(?<id>[^/]+)\/home$/u, "$<id>")(run.home);
			const login = yield* mustRun(run, ["gh", "api", "user", "--jq", ".login"]);

			yield* mustRun(run, ["gh", "repo", "clone", repository, "scratch", "--", "-q"]);

			const quiet = yield* openPullRequest(run, `${tag}-quiet`);
			const reviewed = yield* openPullRequest(run, `${tag}-reviewed`);

			const close = Effect.forEach([quiet, reviewed], (url) =>
				Effect.ignore(run.exec(["gh", "pr", "close", url, "--delete-branch"])),
			);

			yield* Effect.gen(function* () {
				yield* run.root.prompt(
					`Start one watch with the watch tool on exactly this command: pr-wait ${quiet} ${reviewed}\nThen end your turn without waiting for it.`,
				);
				yield* untilFirstReading;
				yield* mustRun(run, ["gh", "pr", "review", reviewed, "--comment", "--body", "Looks fine."]);

				const outcome = yield* run.waitFor("the watch's wake", "4 minutes", ({ root }) =>
					watchWakeIn(root.entries),
				);

				const tail = outcome.tail ?? "";
				const expected = `${repository}#${numberOf(reviewed)} review by ${login}: COMMENTED`;

				yield* run.say(outcome);
				yield* run.check(
					outcome.status === "fired" && outcome.exit_code === 0,
					`the watch exits 0 (it ${outcome.status} with ${String(outcome.exit_code)})`,
				);
				yield* run.check(Str.includes(expected)(tail), `the watch prints "${expected}" (it printed ${tail})`);
				yield* run.check(
					!Str.includes(`#${numberOf(quiet)} review by`)(tail),
					`the watch reports no review on the quiet pull request (it printed ${tail})`,
				);
			}).pipe(Effect.ensuring(close));
		}),
});
