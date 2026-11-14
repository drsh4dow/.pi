/**
 * A pi extension the driver's `bin/pi` wrapper loads into every pi of a run, delegates included. It records what each
 * session loaded and the text of every request it sent, one JSON line each, to `$PI_DRIVER_PROBE/<pid>.jsonl`. It only
 * listens: no handler returns a value, and it does nothing while `PI_DRIVER_PROBE` is unset.
 */
import {
	type BeforeProviderRequestEvent,
	type ExtensionAPI,
	type ExtensionContext,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export const Probed = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("loaded"),
		session: Schema.String,
		version: Schema.String,
		model: Schema.String,
		contextWindow: Schema.Finite,
		extensions: Schema.Array(Schema.String),
	}),
	Schema.Struct({ type: Schema.Literal("request"), session: Schema.String, text: Schema.String }),
]);

export type Probed = typeof Probed.Type;

/** Holds for every array, and every array in a JSON value is a JSON array. */
const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Arr.isArray(value);

const leavesOf = (value: Schema.Json): ReadonlyArray<string> => {
	if (Predicate.isString(value)) {
		return [value];
	}

	if (isJsonArray(value)) {
		return Arr.flatMap(value, leavesOf);
	}

	if (value === null || Predicate.isNumber(value) || Predicate.isBoolean(value)) {
		return [];
	}

	return Arr.flatMap(Rec.values(value), leavesOf);
};

/** Every string in a provider payload, in traversal order, one per line. Scenarios search it with `includes`. */
export const textOf = (payload: Schema.Json): string => Arr.join(leavesOf(payload), "\n");

const target = Config.option(Config.String("PI_DRIVER_PROBE"));

const encodeLine = Schema.encodeEffect(Schema.fromJsonString(Probed));

const asJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const record = (line: Probed) =>
	Effect.gen(function* () {
		const folder = yield* target;

		if (Option.isNone(folder)) {
			return;
		}

		const fs = yield* FileSystem.FileSystem;
		const json = yield* encodeLine(line);

		yield* fs.writeFileString(`${folder.value}/${String(process.pid)}.jsonl`, `${json}\n`, { flag: "a" });
	});

/** Files of the tools and the extension commands pi registered. Built-in tools name no file, and skills are commands. */
const extensionFilesOf = (pi: ExtensionAPI) => {
	const tools = Arr.map(pi.getAllTools(), (tool) => tool.sourceInfo.path);
	const commands = Arr.filter(pi.getCommands(), (command) => command.source === "extension");

	return Arr.filter([...tools, ...Arr.map(commands, (command) => command.sourceInfo.path)], Str.startsWith("/"));
};

const loaded = (pi: ExtensionAPI, ctx: ExtensionContext) =>
	Effect.gen(function* () {
		const { model } = ctx;

		if (model === undefined) {
			return;
		}

		const fs = yield* FileSystem.FileSystem;
		const extensions = yield* Effect.forEach(extensionFilesOf(pi), (file) => fs.realPath(file));

		yield* record({
			type: "loaded",
			session: ctx.sessionManager.getSessionId(),
			version: VERSION,
			model: `${model.provider}/${model.id}`,
			contextWindow: model.contextWindow,
			extensions: Arr.sort(Arr.dedupe(extensions), Order.String),
		});
	});

const sent = (event: BeforeProviderRequestEvent, ctx: ExtensionContext) =>
	Effect.gen(function* () {
		const json = yield* Effect.flatMap(encodePayload(event.payload), asJson);

		yield* record({ type: "request", session: ctx.sessionManager.getSessionId(), text: textOf(json) });
	});

const run = <Failure>(effect: Effect.Effect<void, Failure, FileSystem.FileSystem>) =>
	Effect.runPromise(Effect.provide(effect, NodeServices.layer));

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => run(loaded(pi, ctx)));
	// The probe loads first, so at `session_start` the extensions that register tools in their own handler have not yet.
	pi.on("agent_start", (_event, ctx) => run(loaded(pi, ctx)));
	pi.on("before_provider_request", (event, ctx) => run(sent(event, ctx)));
}
