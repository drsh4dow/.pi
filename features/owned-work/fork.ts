import { contentText } from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	SessionBeforeForkEvent,
	SessionEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { Hc, type HcError, type TerminalAddress, terminalNameOf } from "../../clients/hc/index.ts";
import { HerdrApp, type HerdrAppError } from "../../clients/herdr-app/index.ts";
import { PiSessions, type SessionUnwritable } from "../../clients/pi-sessions/index.ts";
import { entryKind, unsettledRefs } from "./recorded.ts";

type Sessions = ExtensionContext["sessionManager"];

/** The label herdr-app reads to show a terminal in one of its spaces, in a tab of its own. */
const spaceLabel = "herdr.space";

/** Set on a fork's pi, whose owned-work puts it back in the editor when the fork starts. */
export const draftVariable = "PI_OWNED_WORK_DRAFT";

/**
 * What `/fork` or `/clone` copies: the path to `leaf`, or nothing when that path holds no message yet, and for `/fork`
 * the prompt it puts back in the editor.
 */
export interface ForkPlan {
	readonly leaf: Option.Option<string>;
	readonly draft: Option.Option<string>;
}

const isConversation = (entry: SessionEntry): boolean =>
	entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant");

/** Pi's own choice of path and prompt for `/fork` (`before` a user message) and `/clone` (`at` the leaf). */
export const forkPlanOf =
	(manager: Pick<Sessions, "getEntry" | "getBranch">) =>
	({ entryId, position }: Pick<SessionBeforeForkEvent, "entryId" | "position">): Option.Option<ForkPlan> => {
		const entry = Option.fromUndefinedOr(manager.getEntry(entryId));

		const cut = Option.flatMap(entry, (selected) => {
			if (position === "at") {
				return Option.some({ leaf: Option.some(selected.id), draft: Option.none<string>() });
			}

			if (selected.type !== "message" || selected.message.role !== "user") {
				return Option.none();
			}

			return Option.some({
				leaf: Option.fromNullishOr(selected.parentId),
				draft: Option.some(contentText(selected.message.content, "")),
			});
		});

		return Option.map(cut, ({ leaf, draft }) => ({
			leaf: Option.filter(leaf, (id) => Arr.some(manager.getBranch(id), isConversation)),
			draft,
		}));
	};

/** The herdr-app space `terminal` shows in, so a fork opens beside it. None outside herdr-app. */
const spaceOf = (terminal: Option.Option<TerminalAddress>): Effect.Effect<Option.Option<string>, HcError, Hc> =>
	Option.match(terminal, {
		onNone: () => Effect.succeedNone,
		onSome: (address) =>
			Effect.map(
				Effect.flatMap(Hc, (hc) => hc.labelsOf(address)),
				(labels) => Option.fromUndefinedOr(labels[spaceLabel]),
			),
	});

const noteOf = (refs: ReadonlyArray<string>) =>
	Option.map(Arr.match(refs, { onEmpty: Option.none, onNonEmpty: Option.some }), (named) => ({
		customType: entryKind,
		content: `This session is a fork. ${Arr.join(named, ", ")} kept running in the session it was forked from: their results go there, and stop cannot reach them from here.`,
	}));

interface TabRequest {
	readonly plan: ForkPlan;
	readonly manager: Pick<Sessions, "getBranch" | "getSessionDir">;
	readonly source: string;
	readonly space: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
}

/** The herdr-app window learns of a new terminal a moment after hc starts it. */
const untilShown = { times: 20, schedule: Schedule.spaced("150 millis") };

/** Starts the fork's pi in a new herdr-app tab beside this one and shows it. This session and its work stay as they are. */
const openInTab = ({ plan, manager, source, space, cwd, env }: TabRequest) =>
	Effect.gen(function* () {
		const hc = yield* Hc;
		const sessions = yield* PiSessions;
		const herdrApp = yield* HerdrApp;

		const branch = (leaf: string) => {
			const note = noteOf(unsettledRefs(manager.getBranch(leaf)));

			return sessions.branch({ source, dir: manager.getSessionDir(), leaf, note });
		};

		const session = yield* Effect.forEach(Option.toArray(plan.leaf), branch);

		const draft = Option.match(plan.draft, { onNone: () => ({}), onSome: (text) => ({ [draftVariable]: text }) });

		const terminal = yield* hc.open({
			name: terminalNameOf("fork"),
			labels: { [spaceLabel]: space },
			argv: ["pi", ...Arr.flatMap(session, (file) => ["--session", file])],
			cwd,
			env: { ...env, ...draft },
		});

		const unfocused = yield* herdrApp.focus(terminal).pipe(Effect.retry(untilShown), Effect.flip, Effect.option);

		return { terminal, unfocused };
	});

const failureOf = (error: HcError | SessionUnwritable | HerdrAppError): string =>
	Match.valueTags(error, {
		HcError: ({ message }) => message,
		SessionUnwritable: ({ why }) => why,
		HerdrAppError: ({ message }) => message,
	});

const opened = ({ terminal, unfocused }: { terminal: TerminalAddress; unfocused: Option.Option<HerdrAppError> }) =>
	Option.match(unfocused, {
		onNone: () => ({ text: `Opened the fork in a new tab (${terminal}).`, level: "info" as const }),
		onSome: (error) => ({
			text: `Opened the fork in a new tab (${terminal}), but could not switch to it: ${failureOf(error)}`,
			level: "warning" as const,
		}),
	});

const spaceOrWarn = (terminal: Option.Option<TerminalAddress>, ctx: Pick<ExtensionContext, "ui">) =>
	Effect.catchTag(spaceOf(terminal), "HcError", ({ message }) => {
		ctx.ui.notify(`Could not find this tab in herdr-app, so the fork replaces this session: ${message}`, "warning");

		return Effect.succeedNone;
	});

export interface ForkRequest {
	readonly event: SessionBeforeForkEvent;
	readonly ctx: Pick<ExtensionContext, "mode" | "cwd" | "sessionManager" | "ui">;
	/** The hc terminal this pi runs in. */
	readonly terminal: Option.Option<TerminalAddress>;
	readonly env: Readonly<Record<string, string>>;
}

/**
 * In a herdr-app tab, `/fork` and `/clone` open the copy in a new tab beside this one, so this session keeps running
 * with its work. False when pi has to fork in place instead: outside herdr-app, or for a session with no file.
 */
export const forkInTab = ({ event, ctx, terminal, env }: ForkRequest) =>
	Effect.gen(function* () {
		const space = yield* ctx.mode === "tui" ? spaceOrWarn(terminal, ctx) : Effect.succeedNone;
		const plan = forkPlanOf(ctx.sessionManager)(event);
		const source = Option.fromUndefinedOr(ctx.sessionManager.getSessionFile());
		const site = Option.all({ plan, source, space });

		if (Option.isNone(site)) {
			return false;
		}

		yield* openInTab({ ...site.value, manager: ctx.sessionManager, cwd: ctx.cwd, env }).pipe(
			Effect.match({
				onSuccess: (tab) => {
					const { text, level } = opened(tab);

					ctx.ui.notify(text, level);
				},
				onFailure: (error) => {
					ctx.ui.notify(`Could not open the fork: ${failureOf(error)}`, "error");
				},
			}),
		);

		return true;
	});

/** A fork's pi puts back in the editor the prompt `/fork` took it from, once, when it starts. */
export const restoreDraft = ({
	event,
	ctx,
	env,
}: {
	readonly event: SessionStartEvent;
	readonly ctx: ExtensionContext;
	readonly env: Readonly<Record<string, string | undefined>>;
}): void => {
	const draft = Option.fromUndefinedOr(env[draftVariable]);

	if (event.reason === "startup" && ctx.hasUI && Option.isSome(draft)) {
		ctx.ui.setEditorText(draft.value);
	}
};
