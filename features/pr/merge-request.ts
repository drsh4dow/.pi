import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Str from "effect/String";

/** What a `gh` call asks to merge. `via` says how the real call takes the head pin. */
export type MergeRequest = Data.TaggedEnum<{
	Merge: { readonly pr: string; readonly via: "pr" | "api" };
	StackMerge: { readonly ceiling: string };
	Refuse: { readonly why: string };
}>;

export const MergeRequest = Data.taggedEnum<MergeRequest>();

const valueFlags = new Set([
	"-R",
	"--repo",
	"-b",
	"--body",
	"-F",
	"--body-file",
	"-t",
	"--subject",
	"-A",
	"--author-email",
	"--match-head-commit",
	"--merge-method",
	"-X",
	"--method",
	"-H",
	"--header",
	"-f",
	"--raw-field",
	"--field",
	"--input",
	"-q",
	"--jq",
	"--template",
	"--cache",
	"-p",
	"--preview",
	"--hostname",
]);

type Flag = readonly [name: string, value: string];

interface Parsed {
	readonly positionals: ReadonlyArray<string>;
	readonly flags: ReadonlyArray<Flag>;
}

const flagOf = (token: string, rest: ReadonlyArray<string>): readonly [Flag, ReadonlyArray<string>] => {
	const equals = Str.indexOf("=")(token);

	if (Str.startsWith("--")(token) && Option.isSome(equals)) {
		return [[Str.slice(0, equals.value)(token), Str.slice(equals.value + 1)(token)], rest];
	}

	const short = Str.slice(0, 2)(token);

	if (!Str.startsWith("--")(token) && token.length > 2 && valueFlags.has(short)) {
		return [[short, Str.replace(/^=/u, "")(Str.slice(2)(token))], rest];
	}

	return valueFlags.has(token) ? [[token, rest[0] ?? ""], Arr.drop(rest, 1)] : [[token, "true"], rest];
};

const parsed = (argv: ReadonlyArray<string>): Parsed => {
	const [token, ...rest] = argv;

	if (token === undefined) {
		return { positionals: [], flags: [] };
	}

	if (!Str.startsWith("-")(token)) {
		const after = parsed(rest);

		return { ...after, positionals: [token, ...after.positionals] };
	}

	const [flag, left] = flagOf(token, rest);
	const after = parsed(left);

	return { ...after, flags: [flag, ...after.flags] };
};

type Values = (...names: ReadonlyArray<string>) => ReadonlyArray<string>;

/** The spellings of false that gh's flag parser accepts. */
const falseValues = new Set(["false", "0", "f", "F", "FALSE", "False"]);

const isOn = (values: ReadonlyArray<string>) => Option.exists(Arr.last(values), (value) => !falseValues.has(value));

const refuse = (lines: ReadonlyArray<string>) => MergeRequest.Refuse({ why: Arr.join(lines, "\n") });

const deferred = (pr: string) =>
	refuse([
		"merge gate: a deferred merge is refused.",
		"GitHub would merge later, at whatever head is ready then, without this check.",
		`Wait for the checks with \`gh pr checks ${pr} --watch\`, then run \`gh pr merge ${pr} --squash\`.`,
		"The gate pins that merge to the head it checked.",
	]);

/** `-R` takes `[HOST/]OWNER/REPO`. */
const prUrl = (repo: string, number: string) =>
	Str.split(repo, "/").length === 3 ? `https://${repo}/pull/${number}` : `https://github.com/${repo}/pull/${number}`;

/** None for a branch name with `-R`: gh resolves it in that repository, and the gate cannot. */
const selectorOf = (target: string, repo: Option.Option<string>): Option.Option<string> => {
	if (/^\d+$/u.test(target)) {
		return Option.some(Option.match(repo, { onNone: () => target, onSome: (named) => prUrl(named, target) }));
	}

	return Option.isSome(repo) && !Str.startsWith("https://")(target) ? Option.none() : Option.some(target);
};

const prMergeOf = (target: string | undefined, values: Values): Option.Option<MergeRequest> => {
	if (isOn(values("--disable-auto"))) {
		return Option.none();
	}

	if (isOn(values("--auto"))) {
		return Option.some(deferred(target ?? "<number>"));
	}

	if (target === undefined) {
		return Option.some(
			refuse([
				"merge gate: name the pull request, as in `gh pr merge <number> --squash`.",
				"The gate checks the verdicts of the pull request you name.",
			]),
		);
	}

	const selector = selectorOf(target, Arr.last(values("-R", "--repo")));

	return Option.some(
		Option.match(selector, {
			onNone: () =>
				refuse([
					"merge gate: with -R, name the pull request by number or URL, as in `gh pr merge <number> -R <owner/repo> --squash`.",
					"The gate would read a branch name in this folder's repository, not the one -R names.",
				]),
			onSome: (pr) => MergeRequest.Merge({ pr, via: "pr" }),
		}),
	);
};

const stackMergeOf = (target: string | undefined): MergeRequest =>
	target !== undefined && /^\d+$/u.test(target)
		? MergeRequest.StackMerge({ ceiling: target })
		: refuse([
				"merge gate: name the ceiling by number, as in `gh stack merge <number> --yes --squash`.",
				"The gate checks every pull request up to the one you name.",
			]);

const graphqlMergeOf = (values: Values): Option.Option<MergeRequest> => {
	const query = Arr.join(values("-f", "--raw-field", "-F", "--field"), "\n");

	if (/\benablePullRequestAutoMerge\b/u.test(query)) {
		return Option.some(deferred("<number>"));
	}

	return /\bmergePullRequest\b/u.test(query)
		? Option.some(
				refuse([
					"merge gate: a merge through `gh api graphql` is refused, because it names the pull request by node id, which the gate does not read.",
					"Run `gh pr merge <number> --squash` instead.",
				]),
			)
		: Option.none();
};

/** An endpoint reaches gh as a path, with or without a leading slash or query, or as an absolute API URL. */
const pathOf = (endpoint: string) => Str.replaceAll(/^(?:https:\/\/api\.github\.com)?\/?|\?.*$/gu, "")(endpoint);

const restMerge = /^repos\/(?<repo>[^/]+\/[^/]+)\/pulls\/(?<number>\d+)\/merge\/?$/u;

const apiMergeOf = (endpoint: string, values: Values): Option.Option<MergeRequest> => {
	const path = pathOf(endpoint);

	if (path === "graphql") {
		return graphqlMergeOf(values);
	}

	const method = Option.getOrElse(Arr.last(values("-X", "--method")), () => "GET");
	const { repo, number } = restMerge.exec(path)?.groups ?? {};

	if (Str.toUpperCase(method) !== "PUT" || repo === undefined || number === undefined) {
		return Option.none();
	}

	const pr = Str.includes("{")(repo) ? number : prUrl(repo, number);

	return Option.some(MergeRequest.Merge({ pr, via: "api" }));
};

/** None for a call that merges nothing: the wrapper hands it to the real gh unchanged. */
export const mergeRequestOf = (argv: ReadonlyArray<string>): Option.Option<MergeRequest> => {
	const { positionals, flags } = parsed(argv);
	const [command, sub = "", target] = positionals;
	const values: Values = (...names) => Arr.flatMap(flags, ([name, value]) => (names.includes(name) ? [value] : []));

	if (sub === "merge" && command === "pr") {
		return prMergeOf(target, values);
	}

	if (sub === "merge" && command === "stack") {
		return Option.some(stackMergeOf(target));
	}

	return command === "api" ? apiMergeOf(sub, values) : Option.none();
};
