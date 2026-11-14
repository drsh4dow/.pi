import { afterAll, expect, test } from "bun:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import * as Struct from "effect/Struct";
import type { Static } from "typebox";

import { PiCli, piCliLayer, readStagedBrief } from "../../clients/pi-cli/index.ts";
import { entryKind } from "../state-folder/index.ts";
import { callerOf, delegate, runtime, started, table } from "./brief.fixture.ts";
import type { DelegateParams } from "./brief.ts";
import { type Brief, launch } from "./child.ts";
import { Tools } from "./tools.ts";

const root = `${Bun.env["TMPDIR"] ?? "/tmp"}/owned-work-brief-work-test-${String(process.pid)}`;

const staging = ManagedRuntime.make(Layer.provideMerge(piCliLayer([]), NodeServices.layer));

afterAll(() =>
	Effect.runPromise(
		Effect.andThen(
			Effect.promise(() => staging.dispose()),
			Effect.promise(() => Bun.$`rm -rf ${root}`.quiet()),
		),
	),
);

const goal = "Cap the retries.";

const facts = "Build with make.";

const ownerRules = "Push only to work branches.";

const stateFolder = `${root}/state`;

const otherFolder = `${root}/other`;

await Promise.all([
	Bun.write(`${stateFolder}/facts.md`, `${facts}\n`),
	Bun.write(`${otherFolder}/facts.md`, "Other facts.\n"),
	Bun.write(`${stateFolder}/owner.md`, `${ownerRules}\n`),
]);

const Refusal = Schema.Struct({ message: Schema.String });

const startedBy = (tool: typeof delegate, call: Static<DelegateParams>, caller = callerOf()) =>
	Effect.map(
		Effect.promise(() => tool.execute("call", call, undefined, undefined, caller)),
		() => Arr.map(started.splice(0), ({ brief }) => brief),
	);

const workOf = (brief: Brief) => Struct.pick(brief, ["role", "goal", "state", "facts", "ownerRules"]);

const leafCall = { name: "m", message: "m", role: "leaf", model: "quick" } as const;

test("a root's call that names no goal is a tool error that names the goal field, and starts nothing", () =>
	runtime.runPromise(
		Effect.gen(function* () {
			const { isError, details } = yield* Effect.promise(() =>
				delegate.execute("call", leafCall, undefined, undefined, callerOf()),
			);

			const { message } = yield* Schema.decodeUnknownEffect(Refusal)(details);

			expect({ isError, started: started.splice(0), names: Str.includes("`goal`")(message) }).toEqual({
				isError: true,
				started: [],
				names: true,
			});
		}),
	));

test("a leaf gets the state folder's project facts and no owner rules, and an owner gets both", () =>
	runtime.runPromise(
		Effect.gen(function* () {
			const leaf = yield* startedBy(delegate, { ...leafCall, goal, state: stateFolder });
			const owner = yield* startedBy(delegate, { ...leafCall, role: "owner", goal, state: stateFolder });

			expect(Arr.map([...leaf, ...owner], workOf)).toEqual([
				{ role: "leaf", goal, state: Option.some(stateFolder), facts: Option.some(`${facts}\n`) },
				{
					role: "owner",
					goal,
					state: Option.some(stateFolder),
					facts: Option.some(`${facts}\n`),
					ownerRules: Option.some(`${ownerRules}\n`),
				},
			]);
		}),
	));

test("a call that names no state folder takes the one the caller's session last wrote to, and reads its facts", () =>
	runtime.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const labelled = `${root}/labelled`;
			const session = SessionManager.inMemory();

			yield* fs.makeDirectory(labelled, { recursive: true });
			yield* fs.writeFileString(`${labelled}/facts.md`, "Labelled facts.");
			session.appendCustomEntry(entryKind, { folder: labelled });

			const briefs = yield* startedBy(delegate, { ...leafCall, goal }, { ...callerOf(), sessionManager: session });

			expect(Arr.map(briefs, workOf)).toEqual([
				{ role: "leaf", goal, state: Option.some(labelled), facts: Option.some("Labelled facts.") },
			]);
		}),
	));

test("each call reads the state folder's facts afresh, so an edit reaches the next delegate", () =>
	runtime.runPromise(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const folder = `${root}/edited`;
			const call = { ...leafCall, goal, state: folder };

			yield* fs.makeDirectory(folder, { recursive: true });
			yield* fs.writeFileString(`${folder}/facts.md`, "Old facts.");

			const before = yield* startedBy(delegate, call);

			yield* fs.writeFileString(`${folder}/facts.md`, "New facts.");

			const after = yield* startedBy(delegate, call);

			expect(Arr.map([...before, ...after], ({ facts: read }) => read)).toEqual([
				Option.some("Old facts."),
				Option.some("New facts."),
			]);
		}),
	));

const delegatesFolder = `${root}/delegates`;

const ownerTool = (own: { readonly dir: string; readonly id: string }) =>
	Tools.delegate(runtime, 3, { cwd: "/", dir: "/d" }, table, Option.some(own));

const stagedAs = (id: string, level: number) => (briefs: ReadonlyArray<Brief>) =>
	Effect.gen(function* () {
		const pi = yield* PiCli;
		const brief = yield* Effect.fromOption(Arr.head(briefs));
		const childSession = { id, cwd: "/", dir: delegatesFolder };

		yield* launch(pi)({ brief, level, childSession, passEnv: {} });

		return { dir: delegatesFolder, id };
	});

test("an owner's staged brief carries the root's goal, state folder and owner rules, and its leaf inherits the goal and state folder unless it names its own", () =>
	staging.runPromise(
		Effect.gen(function* () {
			const owner = yield* Effect.flatMap(
				startedBy(delegate, { ...leafCall, role: "owner", goal, state: stateFolder }),
				stagedAs("owner", 2),
			);

			const leafRead = (call: Static<DelegateParams>, id: string) =>
				startedBy(ownerTool(owner), call).pipe(Effect.flatMap(stagedAs(id, 3)), Effect.flatMap(readStagedBrief));

			const ownerStaged = yield* readStagedBrief(owner);
			const inherited = yield* leafRead(leafCall, "inherits");
			const overridden = yield* leafRead({ ...leafCall, goal: "Cap the retries at three." }, "overrides");
			const moved = yield* leafRead({ ...leafCall, state: otherFolder }, "moves");
			const work = { state: Option.some(stateFolder), facts: Option.some(`${facts}\n`) };

			expect([ownerStaged, inherited, overridden, moved]).toEqual([
				{ ...work, role: "owner", goal, ownerRules: Option.some(`${ownerRules}\n`), instructions: Option.none() },
				{ ...work, role: "leaf", goal, instructions: Option.none() },
				{ ...work, role: "leaf", goal: "Cap the retries at three.", instructions: Option.none() },
				{
					role: "leaf",
					goal,
					state: Option.some(otherFolder),
					facts: Option.some("Other facts.\n"),
					instructions: Option.none(),
				},
			]);
		}),
	));

test("a delegate whose own brief cannot be read refuses to start one, naming the file", () =>
	runtime.runPromise(
		Effect.gen(function* () {
			const tool = ownerTool({ dir: delegatesFolder, id: "unstaged" });

			const { isError, details } = yield* Effect.promise(() =>
				tool.execute("call", leafCall, undefined, undefined, callerOf()),
			);

			expect({ isError, details, started: started.splice(0) }).toEqual({
				isError: true,
				details: {
					error: "BadDelegate",
					message: `cannot read your own brief ${delegatesFolder}/unstaged.brief.json: NotFound`,
				},
				started: [],
			});
		}),
	));
