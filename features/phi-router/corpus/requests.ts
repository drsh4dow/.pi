import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/encoding";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { Reply } from "../anthropic.fixture.ts";
import { fillerMark, type Plan, planOf, type Sent, Step } from "../corpus-wire.ts";
import type { Case, Part, Transcript, Turn } from "./manifest.ts";

const text = (value: string): Part => ({ kind: "text", text: value });

const userTurn = (sent: Sent): Turn => {
	if (Predicate.isString(sent)) {
		return { role: "user", parts: [text(sent)] };
	}

	const images = Arr.map(sent.images, ({ data, mimeType }): Part => ({ kind: "image", mimeType, data }));

	return { role: "user", parts: [text(sent.text), ...images] };
};

const summaryTurn = (summary: string, read: ReadonlyArray<string>): Turn => {
	const files = Arr.sort(Arr.dedupe(read), Order.String);
	const listed = Arr.isReadonlyArrayNonEmpty(files) ? `\n\n<read-files>\n${Arr.join(files, "\n")}\n</read-files>` : "";
	const wrapped = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}${listed}\n</summary>`;

	return { role: "user", parts: [text(wrapped)] };
};

const isFiller = (turn: Turn) =>
	turn.role === "user" && Arr.some(turn.parts, (part) => part.kind === "text" && Str.includes(fillerMark)(part.text));

class UnknownToolCall extends Schema.TaggedError<UnknownToolCall, { readonly brand: unique symbol }>()(
	"UnknownToolCall",
	{ tool: Schema.String, input: Schema.String },
) {}

type ToolUse = Extract<Reply, { readonly _tag: "ToolUse" }>;

type Files = Plan["files"];

const fileAt = (files: Files, path: string) =>
	Effect.map(Effect.fromOption(Arr.findFirst(files, (file) => file.path === path)), ({ bytes }) => ({
		bytes,
		content: new TextDecoder().decode(bytes),
	}));

const linesOf = (content: string, first: number, last: number) => {
	const lines = Arr.drop(Str.split("\n")(content), first - 1);

	return Arr.join(Arr.take(lines, last - first + 1), "\n");
};

const imageTypes = new Map([
	["png", "image/png"],
	["jpg", "image/jpeg"],
	["gif", "image/gif"],
	["webp", "image/webp"],
]);

const Read = Schema.Struct({
	path: Schema.String,
	offset: Schema.optionalKey(Schema.Int),
	limit: Schema.optionalKey(Schema.Int),
});

/** A page of a file as pi's `read` returns it, with pi's note on how to read on when lines are left. */
const pageOf = (content: string, offset: number, limit: number) => {
	const last = offset + limit - 1;
	const page = linesOf(content, offset, last);
	const rest = Str.split("\n")(content).length - last;

	return rest > 0
		? `${page}\n\n[${String(rest)} more lines in file. Use offset=${String(last + 1)} to continue.]`
		: page;
};

const readOf = (files: Files) => (call: typeof Read.Type) =>
	Effect.map(fileAt(files, call.path), ({ bytes, content }): ReadonlyArray<Part> => {
		const extension = Option.getOrElse(Arr.last(Str.split(".")(call.path)), () => "");
		const mimeType = imageTypes.get(extension);

		if (mimeType !== undefined) {
			return [{ kind: "image", mimeType, data: Encoding.Base64.encode(bytes) }];
		}

		if (call.offset === undefined || call.limit === undefined) {
			return [text(content)];
		}

		return [text(pageOf(content, call.offset, call.limit))];
	});

const Bash = Schema.Struct({ command: Schema.String });

const cat = /^(?:sleep \d+; )?cat (?<path>\S+)$/u;

const sed = /^sed -n '(?<first>\d+),(?<last>\d+)p' (?<path>\S+)$/u;

const bashOf = (files: Files) =>
	Effect.fn("bashOf")(function* ({ command }: typeof Bash.Type) {
		const whole = cat.exec(command)?.groups?.["path"];

		if (whole !== undefined) {
			const { content } = yield* fileAt(files, whole);

			return [text(content)];
		}

		const range = sed.exec(command)?.groups;

		if (range?.["path"] === undefined) {
			return yield* UnknownToolCall.make({ tool: "bash", input: command });
		}

		const { content } = yield* fileAt(files, range["path"]);

		return [text(`${linesOf(content, Number(range["first"]), Number(range["last"]))}\n`)];
	});

const outputOf = (files: Files, call: ToolUse) => {
	if (call.name === "bash") {
		return Effect.flatMap(Schema.decodeUnknownEffect(Bash)(call.input), bashOf(files));
	}

	if (call.name === "read") {
		return Effect.flatMap(Schema.decodeUnknownEffect(Read)(call.input), readOf(files));
	}

	return Effect.fail(UnknownToolCall.make({ tool: call.name, input: "" }));
};

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

interface Pi {
	readonly turns: Transcript;
	readonly pathsRead: ReadonlyArray<string>;
	readonly replies: ReadonlyArray<Reply>;
	readonly requests: ReadonlyArray<Transcript>;
}

const turnsOf = Effect.fn("turnsOf")(function* (files: Files, requests: number, reply: Reply) {
	if (Reply.$is("Text")(reply)) {
		return [{ role: "assistant", parts: [text(reply.text)] }] satisfies Transcript;
	}

	const id = `toolu_mock_${String(requests)}`;
	const json = yield* encodeJson(reply.input);
	const output = yield* outputOf(files, reply);
	const before = Option.toArray(Option.map(reply.before, text));

	return [
		{ role: "assistant", parts: [...before, text(`${reply.name} ${id} ${json}`)] },
		{ role: "tool", parts: [text(id), ...output] },
	] satisfies Transcript;
});

type Failure = Effect.Error<ReturnType<typeof turnsOf>>;

const pathRead = (reply: Reply) =>
	Reply.$is("ToolUse")(reply) && reply.name === "read"
		? Option.map(Schema.decodeUnknownOption(Read)(reply.input), ({ path }) => path)
		: Option.none();

const replyTo = (pi: Pi) => {
	if (Option.exists(Arr.last(pi.turns), isFiller)) {
		return { reply: Reply.Text({ text: "ok" }), replies: pi.replies };
	}

	const [reply = Reply.Text({ text: "done" }), ...replies] = pi.replies;

	return { reply, replies };
};

const prompted = (files: Files, pi: Pi, steer: Option.Option<Sent>): Effect.Effect<Pi, Failure> =>
	Effect.gen(function* () {
		const requests = [...pi.requests, pi.turns];
		const { reply, replies } = replyTo(pi);
		const answer = yield* turnsOf(files, requests.length, reply);
		const pathsRead = [...pi.pathsRead, ...Option.toArray(pathRead(reply))];
		const next = { turns: [...pi.turns, ...answer], pathsRead, replies, requests };

		if (Option.isSome(steer)) {
			return yield* prompted(files, { ...next, turns: [...next.turns, userTurn(steer.value)] }, Option.none());
		}

		return Reply.$is("ToolUse")(reply) ? yield* prompted(files, next, Option.none()) : next;
	});

const compacted = (pi: Pi, summary: string): Pi => {
	const kept = Option.getOrElse(
		Arr.findLastIndex(pi.turns, (turn) => turn.role === "user"),
		() => pi.turns.length,
	);

	return { ...pi, turns: [summaryTurn(summary, pi.pathsRead), ...Arr.drop(pi.turns, kept)] };
};

const played = (files: Files) => (pi: Pi, step: Step) =>
	Step.$match(step, {
		Turn: ({ prompt, steer }) => prompted(files, { ...pi, turns: [...pi.turns, userTurn(prompt)] }, steer),
		Compact: ({ summary }) => Effect.succeed(compacted(pi, summary)),
	});

/**
 * The conversation each request carries, in order, without system turns: the scenario's pi sends its own system
 * prompt. Compaction requests are left out, since they route `direct` to the BAA account.
 */
export const requestsOf = Effect.fn("requestsOf")(function* (subject: Case) {
	const plan = planOf(subject);
	const start: Pi = { turns: [], pathsRead: [], replies: plan.replies, requests: [] };
	const end = yield* Effect.reduce(plan.steps, () => start, played(plan.files));

	return end.requests;
});
