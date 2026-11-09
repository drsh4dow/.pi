import { type AssistantMessage, contentText } from "@earendil-works/pi-ai";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export interface SessionAddress {
	readonly id: string;
	readonly cwd: string;
	readonly dir: string;
}

/** A child's last non-empty assistant text, or the provider error its last call ended on. */
export type ChildReply = Data.TaggedEnum<{
	Answered: { readonly text: string };
	Errored: { readonly why: string };
}>;

export const ChildReply = Data.taggedEnum<ChildReply>();

export class PiSessions extends Context.Service<
	PiSessions,
	{
		/** None when the child has no text, its last call was aborted, or its session is missing or unreadable. */
		readonly readAnswer: (session: SessionAddress) => Effect.Effect<Option.Option<ChildReply>>;
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

const replyOf = (messages: ReadonlyArray<AssistantMessage>): Option.Option<ChildReply> =>
	Option.flatMap(Arr.last(messages), (last) =>
		Match.value(last.stopReason).pipe(
			Match.when("error", () => Option.some(ChildReply.Errored({ why: last.errorMessage ?? "provider error" }))),
			Match.when("aborted", () => Option.none()),
			Match.orElse(() => Option.map(Arr.findLast(messages, textOf), (text) => ChildReply.Answered({ text }))),
		),
	);

const assistantMessages = (file: string, dir: string) => {
	const branch = SessionManager.open(file, dir).getBranch();

	return Arr.getSomes(Arr.map(branch, assistantOf));
};

const lastReply = ({ cwd, id, dir }: SessionAddress) =>
	Option.flatMap(Option.fromUndefinedOr(SessionManager.findById(cwd, id, dir)), (file) =>
		replyOf(assistantMessages(file, dir)),
	);

export const piSessionsLayer = Layer.succeed(PiSessions, {
	readAnswer: (session) =>
		Effect.try({
			try: () => lastReply(session),
			catch: (cause) => SessionUnreadable.make({ id: session.id, why: String(cause) }),
		}).pipe(Effect.tapError(Effect.logWarning), Effect.orElseSucceed(Option.none)),
});
