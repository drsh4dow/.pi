/**
 * The engine eval: plays each corpus case through the router core as pi would send it, request by request, and checks
 * what a personal account would receive. A complete canary in that view is a leak, and so is every part of a split one
 * across the case's personal requests. A part alone is a fragment.
 */
import type { Message } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { guard } from "../border.ts";
import { foundIn, tokensOf } from "../canary-tokens.ts";
import { Finding, type Judge, Verdict } from "../policy/engine.ts";
import { decide } from "../route.ts";
import { memoryBook, type VerdictBook } from "../store.ts";
import type { Case } from "./manifest.ts";
import { requestMessagesOf } from "./messages.ts";
import { type Played, type Report, reportOf, type Sent, type Tracked } from "./report.ts";

/** Image bytes are left out: the corpus images are harmless pixels, not identifiers. */
const trackedOf = Effect.fn("trackedOf")(function* (subject: Case) {
	if (subject.expect === "clean") {
		return [];
	}

	const images = new Set(Arr.flatMap(subject.messages, (message) => ("image" in message ? [message.image.data] : [])));

	return yield* Effect.forEach(subject.canaries, (canary) =>
		Effect.map(tokensOf({ ...subject, canaries: [canary] }), ({ tokens }): Tracked => {
			const shown = Arr.filter(tokens, (token) => !images.has(token));
			const split = shown.length > 1;

			return { canary, complete: split ? [canary] : Arr.dedupe([canary, ...shown]), parts: split ? shown : [] };
		}),
	);
});

const encodeView = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** The guarded messages as one JSON body, so a canary counts raw, JSON-escaped or decoded from a string. */
const bodyOf = (messages: ReadonlyArray<Message>) => Option.getOrElse(encodeView(messages), () => "");

/** What a personal account receives of `messages`: nothing when the border refuses the request. */
const shownOf = ({ messages, book, tracked }: Pick<Turn, "messages" | "book" | "tracked">) => {
	const view = Result.match(guard({ messages, lookup: book.lookup }), {
		onFailure: () => [],
		onSuccess: (guarded) => guarded.messages,
	});

	const bodies = [bodyOf(view)];

	return {
		leaked: Arr.flatMap(tracked, ({ canary, complete }) =>
			Arr.isReadonlyArrayNonEmpty(foundIn({ bodies, tokens: complete })) ? [canary] : [],
		),
		parts: Arr.flatMap(tracked, ({ parts }) => foundIn({ bodies, tokens: parts })),
	};
};

const isFailure = Verdict.$match({
	Cleared: () => false,
	Sealed: ({ finding }) => Finding.$is("Failure")(finding),
});

interface Turn {
	readonly messages: ReadonlyArray<Message>;
	readonly book: VerdictBook;
	readonly tracked: ReadonlyArray<Tracked>;
	readonly window: number;
}

/** One request through `decide`, which records its verdicts in the book, and through `guard` when it stays personal. */
const sentOf = Effect.fn("sentOf")(function* (turn: Turn) {
	const { messages, book, window } = turn;
	const reason = Option.exists(Arr.last(messages), ({ role }) => role === "toolResult") ? "continuation" : "user";
	const hold = Option.none();
	const decision = yield* decide({ messages, reason, book, hold, producedOnPersonal: () => false, window });
	const failures = Arr.filter(decision.found, ([, verdict]) => isFailure(verdict)).length;
	const shown = decision.lane === "personal" ? shownOf(turn) : { leaked: [], parts: [] };

	return { lane: decision.lane, usage: decision.usage, failures, ...shown } satisfies Sent;
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
	const tracked = yield* trackedOf(subject);
	const requests = yield* requestMessagesOf(subject);
	const book = memoryBook();
	const sent = yield* Effect.forEach(requests, (messages) => sentOf({ messages, book, tracked, window }));

	return { case: subject, sent, tracked } satisfies Played;
});

/** The engine eval over `cases` with a judge window of `window` preceding items. */
export const evaluate = Effect.fn("evaluate")(function* ({
	cases,
	window,
}: {
	readonly cases: ReadonlyArray<Case>;
	readonly window: number;
}): Effect.fn.Return<Report, never, Judge> {
	const played = yield* Effect.forEach(cases, (subject) => play({ subject, window }), { concurrency: 8 });

	return reportOf({ played, window });
});
