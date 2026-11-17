import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import type { Ledger } from "./ledger.ts";
import type { WorkRef } from "./work.ts";

/** The shortest sleep that counts as waiting for a result. */
const longSleep = 30;

const BashCall = Schema.Struct({ toolName: Schema.Literal("bash"), input: Schema.Struct({ command: Schema.String }) });

/** What a script that called `bash` receives. */
const ScriptResult = Schema.StructWithRest(Schema.Struct({ output: Schema.String }), [Schema.JsonObject]);

const sleepsLong = (command: string): boolean =>
	Arr.some(
		[...Str.matchAll(/\bsleep\s+(?<seconds>\d+(?:\.\d+)?)/gu)(command)],
		(match) => Number(match.groups?.["seconds"]) >= longSleep,
	);

const warningFor = (waking: ReadonlyArray<WorkRef>) => (command: string) =>
	Arr.isReadonlyArrayNonEmpty(waking) && sleepsLong(command)
		? Option.some(`${Arr.join(waking, ", ")} will wake you. End your turn to wait.`)
		: Option.none();

/** Kept beside the text, since pi drops a result's structured content when a handler replaces only its text. */
const scriptWarned = (structuredContent: ToolResultEvent["structuredContent"], warning: string) =>
	Option.match(Schema.decodeUnknownOption(ScriptResult)(structuredContent), {
		onNone: () => ({}),
		onSome: (script) => ({ structuredContent: { ...script, output: `${script.output}\n${warning}` } }),
	});

/**
 * A `bash` call that sleeps while work the agent holds will wake it gets a warning, in the text the model reads and in
 * the `output` a script that made the call reads. The call still runs.
 */
export const warnedResult =
	(waking: ReadonlyArray<WorkRef>) =>
	(
		result: Pick<ToolResultEvent, "toolName" | "input" | "content" | "structuredContent">,
	): Option.Option<ToolResultEventResult> =>
		Option.map(
			Option.flatMap(Schema.decodeUnknownOption(BashCall)(result), ({ input }) => warningFor(waking)(input.command)),
			(warning) => ({
				content: [...result.content, { type: "text" as const, text: warning }],
				...scriptWarned(result.structuredContent, warning),
			}),
		);

/** For pi's `tool_result` hook: the patch for a result, or nothing. */
export const warnPolling = (event: ToolResultEvent) => (ledger: (typeof Ledger)["Service"]) =>
	Effect.map(ledger.waking, (refs) => Option.getOrUndefined(warnedResult(refs)(event)));
