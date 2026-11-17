import { afterAll, beforeAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { Body, type Page, PublicUrl } from "#src/client/web/index.ts";
import { cacheRootOf, noStoreLayer, Store, storeLayer } from "./index.ts";

const root = `${Bun.env["TMPDIR"] ?? "/tmp"}/web-cache-${String(process.pid)}`;

const notAFolder = `${root}/a-file`;

beforeAll(() =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			yield* fs.remove(root, { recursive: true, force: true });
			yield* fs.makeDirectory(root, { recursive: true });
			yield* fs.writeFileString(notAFolder, "");
		}).pipe(Effect.provide(NodeServices.layer)),
	),
);

afterAll(() =>
	Effect.runPromise(
		Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(root, { recursive: true })).pipe(
			Effect.provide(NodeServices.layer),
		),
	),
);

const services = Layer.merge(storeLayer(root).pipe(Layer.provide(NodeServices.layer)), NodeServices.layer);

const url = PublicUrl.make("https://bun.sh/docs/api/http");

const page: Page = {
	url,
	finalUrl: url,
	title: Option.none(),
	via: "direct",
	caveat: Option.none(),
	body: Body.Markdown({ text: "# HTTP" }),
};

const daysAgo = (days: number) => DateTime.formatIsoDateUtc(DateTime.subtract(DateTime.nowUnsafe(), { days }));

test("pruning deletes date folders older than 7 days and keeps the rest", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const names = [daysAgo(8), daysAgo(7), daysAgo(6), "notes"];

			yield* Effect.forEach(names, (name) => fs.makeDirectory(`${root}/${name}`, { recursive: true }));
			yield* Effect.flatMap(Store, ({ prune }) => prune);
			yield* Effect.flatMap(Store, ({ prune }) => prune);

			const left = yield* fs.readDirectory(root);

			expect(Arr.map(names, (name) => Arr.contains(left, name))).toEqual([false, true, true, true]);
		}).pipe(Effect.provide(services)),
	));

const unmadeStore = storeLayer(`${root}/not-made-yet`).pipe(Layer.provide(NodeServices.layer));

test("pruning a cache folder that does not exist yet succeeds", () =>
	Effect.runPromise(
		Effect.provide(
			Effect.flatMap(Store, ({ prune }) => prune),
			unmadeStore,
		),
	));

const savedPath = Effect.flatMap(Store, ({ save }) => save(page)).pipe(
	Effect.map(({ markdown }) => Option.getOrThrow(Option.map(markdown, ({ path }) => path))),
);

test("the same page saved twice gets two files, readable only by the user, even in folders made open before", () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const folder = `${root}/${daysAgo(0)}`;

			yield* fs.makeDirectory(folder, { recursive: true });
			yield* Effect.forEach([root, folder], (open) => fs.chmod(open, 0o755));

			const paths = yield* Effect.all([savedPath, savedPath]);

			const modes = yield* Effect.forEach([...paths, folder, root], (path) =>
				Effect.map(fs.stat(path), ({ mode }) => (mode % 0o1000).toString(8)),
			);

			expect({ distinct: paths[0] !== paths[1], modes }).toEqual({
				distinct: true,
				modes: ["600", "600", "700", "700"],
			});
		}).pipe(Effect.provide(services)),
	));

const cacheRootRows: ReadonlyArray<{
	readonly name: string;
	readonly env: Readonly<Record<string, string>>;
	readonly expected: string;
}> = [
	{ name: "XDG_CACHE_HOME and HOME", env: { XDG_CACHE_HOME: "/x", HOME: "/h" }, expected: "/x/pi-web" },
	{ name: "HOME only", env: { HOME: "/h" }, expected: "/h/.cache/pi-web" },
	{ name: "an empty XDG_CACHE_HOME", env: { XDG_CACHE_HOME: "", HOME: "/h" }, expected: "/h/.cache/pi-web" },
	{ name: "an empty HOME", env: { HOME: "" }, expected: "none" },
	{ name: "neither", env: {}, expected: "none" },
];

test.each(cacheRootRows)("with $name, saved pages go to $expected", ({ env, expected }) => {
	expect(Option.getOrElse(cacheRootOf(env), () => "none")).toBe(expected);
});

const failedSaveRows = [
	{
		name: "with no cache folder, saving a page fails and says what to set",
		store: noStoreLayer,
		expect: "not-saved: web_fetch has nowhere to save pages: set HOME or XDG_CACHE_HOME",
	},
	{
		name: "a cache folder that cannot be written fails the save with the disk's reason",
		store: storeLayer(notAFolder).pipe(Layer.provide(NodeServices.layer)),
		expect: "not-saved: could not save https://bun.sh/docs/api/http: ",
	},
];

test.each(failedSaveRows)("$name", ({ store, expect: wanted }) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const got = yield* Effect.flatMap(Store, ({ save }) => save(page)).pipe(
				Effect.match({ onFailure: ({ kind, message }) => `${kind}: ${message}`, onSuccess: () => "saved" }),
			);

			expect(got).toStartWith(wanted);
		}).pipe(Effect.provide(store)),
	),
);
