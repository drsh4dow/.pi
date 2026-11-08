import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export interface SessionAddress {
	readonly id: string;
	readonly cwd: string;
	readonly dir: string;
}

export class PiSessions extends Context.Service<
	PiSessions,
	{
		/** The child's last non-empty assistant text, or none when its last call errored or was aborted. */
		readonly readAnswer: (session: SessionAddress) => Effect.Effect<Option.Option<string>>;
	}
>()("pi-harness/clients/pi-sessions/PiSessions") {}

class SessionUnreadable extends Schema.TaggedError<SessionUnreadable, { readonly brand: unique symbol }>()(
	"SessionUnreadable",
	{
		id: Schema.String,
		why: Schema.String,
	},
) {}

const assistantOf = (entry: SessionEntry) =>
	entry.type === "message" && entry.message.role === "assistant" ? Option.some(entry.message) : Option.none();

const textOf = (message: AssistantMessage) => Option.liftPredicate(contentText(message.content, ""), Str.isNonEmpty);

const brokeOff = (message: AssistantMessage) => message.stopReason === "error" || message.stopReason === "aborted";

const answerOf = (messages: ReadonlyArray<AssistantMessage>) =>
	Option.exists(Arr.last(messages), brokeOff) ? Option.none() : Arr.findLast(messages, textOf);

const assistantMessages = (file: string, dir: string) => {
	const branch = SessionManager.open(file, dir).getBranch();

	return Arr.getSomes(Arr.map(branch, assistantOf));
};

const lastAssistantText = ({ cwd, id, dir }: SessionAddress) =>
	Option.fromUndefinedOr(SessionManager.findById(cwd, id, dir)).pipe(
		Option.flatMap((file) => answerOf(assistantMessages(file, dir))),
	);

export const piSessionsLayer = Layer.succeed(PiSessions, {
	readAnswer: (session) =>
		Effect.try({
			try: () => lastAssistantText(session),
			catch: (cause) => SessionUnreadable.make({ id: session.id, why: String(cause) }),
		}).pipe(Effect.tapError(Effect.logWarning), Effect.orElseSucceed(Option.none)),
});
