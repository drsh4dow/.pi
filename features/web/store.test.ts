import { afterAll, expect, test } from "bun:test";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { Body, type Page, PublicUrl } from "../../clients/web/index.ts";
import { cacheRootOf, noStoreLayer, Store, storeLayer } from "./store.ts";

const root = await Effect.runPromise(
	Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectory()).pipe(Effect.provide(NodeServices.layer)),
);

afterAll(() =>
	Effect.runPromise(
		Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(root, { recursive: true })).pipe(
			Effect.provide(NodeServices.layer),
		),
	),
);

const services = Layer.merge(storeLayer(root).pipe(Layer.provide(NodeServices.layer)), NodeServices.layer);

const url = await Effect.runPromise(Schema.decodeEffect(PublicUrl)("https://bun.sh/docs/api/http"));

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

const cacheRootRows: ReadonlyArray<readonly [string, Readonly<Record<string, string>>, string]> = [
	["XDG_CACHE_HOME and HOME", { XDG_CACHE_HOME: "/x", HOME: "/h" }, "/x/pi-web"],
	["HOME only", { HOME: "/h" }, "/h/.cache/pi-web"],
	["an empty XDG_CACHE_HOME", { XDG_CACHE_HOME: "", HOME: "/h" }, "/h/.cache/pi-web"],
	["an empty HOME", { HOME: "" }, "none"],
	["neither", {}, "none"],
];

for (const [name, env, expected] of cacheRootRows) {
	test(`with ${name}, saved pages go to ${expected}`, () => {
		expect(Option.getOrElse(cacheRootOf(env), () => "none")).toBe(expected);
	});
}

const notAFolder = `${root}/a-file`;

await Effect.runPromise(
	Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(notAFolder, "")).pipe(
		Effect.provide(NodeServices.layer),
	),
);

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

for (const { name, store, expect: wanted } of failedSaveRows) {
	test(name, () =>
		Effect.runPromise(
			Effect.gen(function* () {
				const got = yield* Effect.flatMap(Store, ({ save }) => save(page)).pipe(
					Effect.match({ onFailure: ({ kind, message }) => `${kind}: ${message}`, onSuccess: () => "saved" }),
				);

				expect(got).toStartWith(wanted);
			}).pipe(Effect.provide(store)),
		),
	);
}
