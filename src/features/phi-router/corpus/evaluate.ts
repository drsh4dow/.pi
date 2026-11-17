import type { Message } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { guard } from "#src/features/phi-router/border.ts";
import { tokensOf } from "#src/features/phi-router/canary-tokens.ts";
import { Finding, type Judge, Verdict } from "#src/features/phi-router/policy/engine.ts";
import { Synthetic } from "#src/features/phi-router/policy/synthetic.ts";
import { decide } from "#src/features/phi-router/route.ts";
import { memoryBook, type VerdictBook } from "#src/features/phi-router/store.ts";
import type { Case, Synthetic as SyntheticList } from "./manifest.ts";
import { requestMessagesOf } from "./messages.ts";
import { type Played, type Report, reportOf, type Sent } from "./report.ts";

const encodeView = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** The messages as one JSON body, as the tracker reads a request a mock received. */
const bodyOf = (messages: ReadonlyArray<Message>) => Option.getOrElse(encodeView(messages), () => "");

const guardedBody = ({ messages, book }: Pick<Turn, "messages" | "book">) =>
	bodyOf(
		Result.match(guard({ messages, lookup: book.lookup }), {
			onFailure: () => [],
			onSuccess: (guarded) => guarded.messages,
		}),
	);

const isFailure = Verdict.$match({
	Cleared: () => false,
	Sealed: ({ finding }) => Finding.$is("Failure")(finding),
});

interface Turn {
	readonly messages: ReadonlyArray<Message>;
	readonly book: VerdictBook;
	readonly window: number;
}

const sentOf = Effect.fn("sentOf")(function* (turn: Turn) {
	const { messages, book, window } = turn;
	const reason = Option.exists(Arr.last(messages), ({ role }) => role === "toolResult") ? "continuation" : "user";
	const hold = Option.none();
	const decision = yield* decide({ messages, reason, book, hold, producedOnPersonal: () => false, window });
	const failures = Arr.filter(decision.found, ([, verdict]) => isFailure(verdict)).length;
	const view = decision.lane === "personal" ? Option.some(guardedBody(turn)) : Option.none();

	return { lane: decision.lane, usage: decision.usage, failures, view } satisfies Sent;
});

/**
 * Every request of the case through `decide` with one book, and each personal one through `guard`. Play never stops at a
 * seal: the requests after it return to the personal lane with the sealed part stubbed, which is what the eval tests.
 */
export const play = Effect.fn("play")(function* ({
	subject,
	window,
}: {
	readonly subject: Case;
	readonly window: number;
}) {
	const tracked = yield* tokensOf(subject);
	const requests = yield* requestMessagesOf(subject);
	const book = memoryBook();
	const sent = yield* Effect.forEach(requests, (messages) => sentOf({ messages, book, window }));

	return { case: subject, sent, tracked } satisfies Played;
});

export const evaluate = Effect.fn("evaluate")(function* ({
	cases,
	synthetic,
	window,
}: {
	readonly cases: ReadonlyArray<Case>;
	readonly synthetic: SyntheticList;
	readonly window: number;
}): Effect.fn.Return<Report, never, Judge> {
	const played = yield* Effect.forEach(cases, (subject) => play({ subject, window }), { concurrency: 8 }).pipe(
		Effect.provideService(Synthetic, synthetic),
	);

	return reportOf({ played, window });
});
