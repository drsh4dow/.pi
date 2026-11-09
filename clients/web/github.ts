import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { pageOf } from "./direct.ts";
import { fetched } from "./guard.ts";
import { type Found, rendered, type Source, unlessGone, type WebError } from "./page.ts";
import { decoded, type Fetched, textOf } from "./text.ts";

/** Unauthenticated API reads are capped at 60 an hour, 5000 with a token. */
const GithubToken = Context.Reference<Effect.Effect<Option.Option<Redacted.Redacted>>>(
	"pi-harness/clients/web/GithubToken",
	{ defaultValue: () => Effect.succeedNone },
);

const fromEnv = Config.option(Config.orElse(Config.Redacted("GH_TOKEN"), () => Config.Redacted("GITHUB_TOKEN")));

const noToken = Option.none<Redacted.Redacted>;

const tokenOf = (out: string) => Option.liftPredicate(Str.trim(out), Str.isNonEmpty).pipe(Option.map(Redacted.make));

export const githubTokenLayer: Layer.Layer<never, never, ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(
	GithubToken,
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

		const fromGh = spawner
			.string(ChildProcess.make("gh", ["auth", "token"]))
			.pipe(Effect.map(tokenOf), Effect.orElseSucceed(noToken));

		const env = yield* Effect.orElseSucceed(fromEnv, noToken);

		return yield* Effect.cached(Option.match(env, { onSome: Effect.succeedSome, onNone: () => fromGh }));
	}),
);

const ApiUrl = Schema.String.pipe(
	Schema.check(Schema.isPattern(/^https:\/\/api\.github\.com\//u)),
	Schema.brand("ApiUrl"),
);

type ApiUrl = typeof ApiUrl.Type;

const repoApi = (path: string) => ApiUrl.make(`https://api.github.com/repos/${path}`);

const api = (url: ApiUrl, accept = "application/vnd.github+json") =>
	Effect.gen(function* () {
		const token = yield* Effect.service(GithubToken).pipe(Effect.flatten);
		const headers = { accept, "x-github-api-version": "2022-11-28" };
		const request = HttpClientRequest.get(url, { headers });

		const authorized = Option.match(token, {
			onNone: () => request,
			onSome: (found) => HttpClientRequest.bearerToken(request, found),
		});

		return yield* fetched(authorized);
	});

const User = Schema.NullOr(Schema.Struct({ login: Schema.String }));

const Post = Schema.Struct({ user: User, created_at: Schema.String, body: Schema.NullOr(Schema.String) });

const Issue = Schema.Struct({ ...Post.fields, title: Schema.String, state: Schema.String });

const Entries = Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }));

type Post = typeof Post.Type;

/** GitHub's Link header points later pages at api.github.com/repositories/<id>/, so the URL is followed whole. */
const nextPage = (page: Fetched) =>
	Option.fromNullishOr(/<(?<next>[^>]+)>;\s*rel="next"/u.exec(page.headers["link"] ?? "")?.groups?.["next"]).pipe(
		Option.flatMap(Schema.decodeUnknownOption(ApiUrl)),
	);

const commentsFrom = (
	url: ApiUrl,
): Effect.Effect<ReadonlyArray<Post>, WebError, Effect.Services<ReturnType<typeof api>>> =>
	Effect.gen(function* () {
		const page = yield* api(url);
		const posts = yield* decoded(Schema.Array(Post))(page);
		const next = nextPage(page);
		const more = Option.isSome(next) ? yield* commentsFrom(next.value) : [];

		return [...posts, ...more];
	});

const postOf = ({ user, created_at, body }: Post) =>
	`**${user?.login ?? "ghost"}**, ${Str.takeLeft(created_at, 10)}\n\n${Str.trim(body ?? "")}`;

const thread = (repo: string, number: number) =>
	Effect.gen(function* () {
		const path = `${repo}/issues/${String(number)}`;
		const issue = yield* Effect.flatMap(api(repoApi(path)), decoded(Issue));
		const comments = yield* commentsFrom(repoApi(`${path}/comments?per_page=100`));
		const heading = `# ${issue.title} (#${String(number)}, ${issue.state})`;
		const posts = Arr.join(Arr.map([issue, ...comments], postOf), "\n\n---\n\n");

		return rendered({ finalUrl: `https://github.com/${path}`, title: issue.title, text: `${heading}\n\n${posts}\n` });
	});

const tree = (repo: string, ref: string, path: string) =>
	Effect.gen(function* () {
		const page = yield* api(repoApi(`${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`));
		const entries = yield* decoded(Entries)(page);
		const base = Arr.join(Arr.filter([ref, path], Str.isNonEmpty), "/");

		const lines = Arr.map(entries, ({ name, type }) =>
			type === "dir"
				? `- [${name}/](https://github.com/${repo}/tree/${base}/${name})`
				: `- [${name}](https://github.com/${repo}/blob/${base}/${name})`,
		);

		const title = `${repo} at ${ref}: /${path}`;

		return rendered({
			finalUrl: `https://github.com/${repo}/tree/${base}`,
			title,
			text: `# ${title}\n\n${Arr.join(lines, "\n")}\n`,
		});
	});

const readme = (repo: string) =>
	Effect.map(api(repoApi(`${repo}/readme`), "application/vnd.github.raw"), (page) =>
		rendered({ finalUrl: `https://github.com/${repo}`, title: `${repo} README`, text: textOf(page) }),
	);

const blob = (repo: string, ref: string, path: string) =>
	fetched(HttpClientRequest.get(`https://raw.githubusercontent.com/${repo}/${ref}/${path}`)).pipe(
		Effect.flatMap(pageOf),
	);

const routeOf = (url: URL): Option.Option<Effect.Effect<Found, WebError, HttpClient.HttpClient>> => {
	const [owner, name, kind, ref, ...rest] = Arr.filter(Str.split(url.pathname, "/"), Str.isNonEmpty);

	if (owner === undefined || name === undefined) {
		return Option.none();
	}

	const repo = `${owner}/${name}`;
	const path = Arr.join(rest, "/");

	return Match.value(kind).pipe(
		Match.when(undefined, () => Option.some(readme(repo))),
		Match.when("blob", () => (ref === undefined || path === "" ? Option.none() : Option.some(blob(repo, ref, path)))),
		Match.when("tree", () => Option.map(Option.fromUndefinedOr(ref), (at) => tree(repo, at, path))),
		Match.whenOr("issues", "pull", () =>
			Option.map(
				Option.filter(Option.fromUndefinedOr(ref), (digits) => /^\d+$/u.test(digits)),
				(number) => thread(repo, Number(number)),
			),
		),
		Match.orElse(() => Option.none()),
	);
};

const read = (url: URL) =>
	Option.match(routeOf(url), {
		onNone: () => Effect.succeedNone,
		onSome: unlessGone,
	});

/** Read through the API, because github.com's HTML hides the middle of long issue threads and wraps files in chrome. */
export const github = {
	via: "github",
	skipsVerdict: true,
	claims: (url: URL) => url.hostname === "github.com",
	read,
} as const satisfies Source<"github">;
