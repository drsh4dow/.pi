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

export { SessionsUnreadable, type Spend, type SpendRequest, spendSince } from "./spend.ts";

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

export interface BranchRequest {
	/** The session file to copy from. It stays unchanged. */
	readonly source: string;
	readonly dir: string;
	/** The last entry the copy keeps. The path to it must hold a message, so pi writes the copy at once. */
	readonly leaf: string;
	/** Appended after `leaf`, where the model reads it on its next turn. */
	readonly note: Option.Option<{ readonly customType: string; readonly content: string }>;
}

export class PiSessions extends Context.Service<
	PiSessions,
	{
		/** None when the child has no text, its last call was aborted, or its session is missing or unreadable. */
		readonly readAnswer: (session: SessionAddress) => Effect.Effect<Option.Option<ChildReply>>;
		/** Writes a new session file holding the path to `leaf`, like pi's `/fork`, and returns its path. */
		readonly branch: (request: BranchRequest) => Effect.Effect<string, SessionUnwritable>;
	}
>()("pi-harness/clients/pi-sessions/PiSessions") {}

export class SessionUnwritable extends Schema.TaggedError<SessionUnwritable, { readonly brand: unique symbol }>()(
	"SessionUnwritable",
	{
		source: Schema.String,
		why: Schema.String,
	},
) {}

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

/** A second manager on the same file, since `createBranchedSession` moves its manager to the copy. */
const branchOf = ({ source, dir, leaf, note }: BranchRequest) => {
	const manager = SessionManager.open(source, dir);
	const copy = manager.createBranchedSession(leaf);

	if (copy === undefined) {
		throw new Error("pi wrote no session file");
	}

	for (const { customType, content } of Option.toArray(note)) {
		manager.appendCustomMessageEntry(customType, content, true);
	}

	return copy;
};

export const piSessionsLayer = Layer.succeed(PiSessions, {
	branch: (request) =>
		Effect.try({
			try: () => branchOf(request),
			catch: (cause) => SessionUnwritable.make({ source: request.source, why: String(cause) }),
		}),
	readAnswer: (session) =>
		Effect.try({
			try: () => lastReply(session),
			catch: (cause) => SessionUnreadable.make({ id: session.id, why: String(cause) }),
		}).pipe(Effect.tapError(Effect.logWarning), Effect.orElseSucceed(Option.none)),
});
