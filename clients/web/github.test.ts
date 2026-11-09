import { expect, test } from "bun:test";

import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { githubTokenLayer } from "./github.ts";
import { bytes, docsPage, missing, plain, prose } from "./transport.fixture.ts";
import { type ReadRow, readOutcome, readRows, webFor } from "./web.fixture.ts";

const issue = {
	title: "bun install hangs behind a proxy",
	state: "open",
	user: { login: "alice" },
	created_at: "2026-03-02T10:00:00Z",
	body: prose("A proxy"),
};

const comment = (login: string, body: string) => ({ user: { login }, created_at: "2026-03-03T00:00:00Z", body });

const comments = "https://api.github.com/repos/oven-sh/bun/issues/12345/comments?per_page=100";

const secondPage = "https://api.github.com/repositories/357728969/issues/12345/comments?per_page=100&page=2";

const issueRoute = "GET https://api.github.com/repos/oven-sh/bun/issues/12345";

const rows: ReadonlyArray<ReadRow> = [
	{
		name: "a Link header to another host is not followed, so the token stays on api.github.com",
		url: "https://github.com/oven-sh/bun/issues/12345",
		routes: {
			[issueRoute]: () => Response.json(issue),
			[`GET ${comments}`]: () =>
				Response.json([comment("bob", "first")], { headers: { link: '<https://evil.example/p2>; rel="next"' } }),
		},
		expect: ["via github", "**bob**, 2026-03-03\n\nfirst"],
	},
	{
		name: "a pull request is read as its thread",
		url: "https://github.com/oven-sh/bun/pull/12345",
		routes: { [issueRoute]: () => Response.json(issue), [`GET ${comments}`]: () => Response.json([]) },
		expect: ["via github", "# bun install hangs behind a proxy (#12345, open)"],
	},
	{
		name: "a GitHub issue comes back with every comment across pages, oldest first",
		url: "https://github.com/oven-sh/bun/issues/12345",
		routes: {
			[issueRoute]: () => Response.json(issue),
			[`GET ${comments}`]: () =>
				Response.json([comment("bob", "first")], { headers: { link: `<${secondPage}>; rel="next"` } }),
			[`GET ${secondPage}`]: () => Response.json([comment("carol", "second")]),
		},
		expect: [
			"via github",
			"# bun install hangs behind a proxy (#12345, open)\n\n**alice**, 2026-03-02\n\nA proxy starts",
			"**bob**, 2026-03-03\n\nfirst\n\n---\n\n**carol**, 2026-03-03\n\nsecond",
		],
	},
	{
		name: "a GitHub file is read raw",
		url: "https://github.com/kepano/defuddle/blob/main/src/node.ts",
		routes: {
			"GET https://raw.githubusercontent.com/kepano/defuddle/main/src/node.ts": plain(
				"export function Defuddle() {}\n",
			),
		},
		expect: [
			"via github",
			"final https://raw.githubusercontent.com/kepano/defuddle/main/src/node.ts",
			"export function",
		],
	},
	{
		name: "a GitHub tree lists each entry as a URL to read next, however short",
		url: "https://github.com/oven-sh/bun/tree/bun-v1.3.2/docs",
		routes: {
			"GET https://api.github.com/repos/oven-sh/bun/contents/docs?ref=bun-v1.3.2": () =>
				Response.json([
					{ name: "api", type: "dir" },
					{ name: "index.md", type: "file" },
				]),
		},
		expect: [
			"- [api/](https://github.com/oven-sh/bun/tree/bun-v1.3.2/docs/api)",
			"- [index.md](https://github.com/oven-sh/bun/blob/bun-v1.3.2/docs/index.md)",
		],
		absent: ["Short page."],
	},
	{
		name: "a GitHub repo is read as its README",
		url: "https://github.com/kepano/defuddle",
		routes: {
			"GET https://api.github.com/repos/kepano/defuddle/readme": bytes("application/vnd.github.raw")(
				new TextEncoder().encode("# defuddle\n"),
			),
		},
		expect: ["via github", "title kepano/defuddle README", "# defuddle"],
	},
	{
		name: "a github.com page that is not a repo falls through to its HTML",
		url: "https://github.com/features/actions",
		routes: {
			"GET https://api.github.com/repos/features/actions/readme": () => Response.json({}, { status: 404 }),
			"GET https://github.com/features/actions": docsPage("GitHub Actions"),
			"GET https://github.com/features/actions.md": missing,
		},
		expect: ["via direct", "title GitHub Actions"],
	},
];

readRows(rows);

const readmeRoutes = {
	"GET https://api.github.com/repos/o/r/readme": (_body: string, headers: Readonly<Record<string, string>>) =>
		new Response(`# r\n\nauth=${headers["authorization"] ?? "none"}`, {
			headers: { "content-type": "application/vnd.github.raw" },
		}),
};

const ghPrinting = (gh: string) =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, {
		...ChildProcessSpawner.make(() => Effect.die("unexpected spawn")),
		string: () => Effect.succeed(gh),
	});

const tokenRows: ReadonlyArray<readonly [string, Readonly<Record<string, string>>, string, string]> = [
	["GH_TOKEN comes first", { GH_TOKEN: "a", GITHUB_TOKEN: "b" }, "c\n", "auth=Bearer a"],
	["GITHUB_TOKEN comes next", { GITHUB_TOKEN: "b" }, "c\n", "auth=Bearer b"],
	["gh auth token comes last", {}, "c\n", "auth=Bearer c"],
	["with no token anywhere the API is read without one", {}, "", "auth=none"],
];

for (const [name, env, gh, expected] of tokenRows) {
	const config = ConfigProvider.layer(ConfigProvider.fromUnknown(env));
	const tokens = Layer.provide(githubTokenLayer, Layer.merge(config, ghPrinting(gh)));
	const web = Layer.provide(webFor({ routes: readmeRoutes }), tokens);

	test(`GitHub's token: ${name}`, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const got = yield* readOutcome("https://github.com/o/r");

				expect(got).toContain(expected);
			}).pipe(Effect.provide(web)),
		));
}
