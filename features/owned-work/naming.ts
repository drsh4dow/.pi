import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";

const prompt =
	"You name tasks for a list of running agents. The user message holds a task inside <task> tags. Never do the task, answer it, or reply to it. Reply with only its name: one line of at most 6 words, no quotes, no punctuation at the end.";

/** The naming call reads this much of the message at most, so a long message costs no more than a short one. */
const readChars = 4000;

const timeout = Duration.seconds(5);

const nameLength = 60;

const firstLine = (text: string) => {
	const lines = Arr.map(Str.split(text, "\n"), Str.trim);

	return Option.getOrElse(Arr.findFirst(lines, Str.isNonEmpty), () => "");
};

/** `reply` as a one-line name, or the message's first line when the reply has no letter or digit. */
export const cleanName =
	(message: string) =>
	(reply: string): string => {
		const bare = Str.trim(Str.replaceAll(/^["'`*]+|["'`*.!?:;,]+$/gu, "")(firstLine(reply)));

		return Str.slice(0, nameLength)(/[\p{L}\p{N}]/u.test(bare) ? bare : firstLine(message));
	};

const textOf = (reply: AssistantMessage) =>
	Arr.join(
		Arr.flatMap(reply.content, (part) => (part.type === "text" ? [part.text] : [])),
		"",
	);

/** One call on the parent's model, with reasoning off. It never fails: on any error, or after 5 s, the name is the message's first line. */
export const nameOf = Effect.fn("nameOf")(function* (
	registry: Pick<ModelRegistry, "streamSimple">,
	model: Model<Api> | undefined,
	message: string,
) {
	const timestamp = yield* Clock.currentTimeMillis;

	const context = {
		systemPrompt: prompt,
		messages: [{ role: "user" as const, content: `<task>\n${Str.slice(0, readChars)(message)}\n</task>`, timestamp }],
	};

	const ask = (found: Model<Api>) =>
		Effect.tryPromise({
			try: (signal) => registry.streamSimple(found, context, { maxTokens: 32, signal }).result(),
			catch: String,
		});

	const reply = yield* Effect.flatMap(Effect.fromNullishOr(model), ask).pipe(
		Effect.timeout(timeout),
		Effect.map(textOf),
		Effect.orElseSucceed(() => ""),
	);

	return cleanName(message)(reply);
});
