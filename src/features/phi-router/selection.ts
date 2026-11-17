import type { Api, Model } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	type ExtensionContext,
	type ModelSelectEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { isProtected, phiId, phiProvider } from "./gate.ts";

interface SelectionContext {
	readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">;
	readonly ui: Pick<ExtensionContext["ui"], "notify">;
	readonly modelRegistry: { readonly find: (provider: string, id: string) => Model<Api> | undefined };
}

type SetModel = (model: ModelSelectEvent["model"]) => Promise<boolean>;

const holdsContent = (branch: ReadonlyArray<SessionEntry>) => buildSessionContext([...branch]).messages.length > 0;

const protectedHistory = (branch: ReadonlyArray<SessionEntry>) =>
	Arr.filter(
		Arr.flatMap(branch, (entry) => {
			if (entry.type === "model_change") {
				return [{ provider: entry.provider, id: entry.modelId }];
			}

			return entry.type === "message" && entry.message.role === "assistant"
				? [{ provider: entry.message.provider, id: entry.message.model }]
				: [];
		}),
		isProtected,
	);

const candidatesOf = (
	ctx: SelectionContext,
	history: ReadonlyArray<{ readonly provider: string; readonly id: string }>,
) =>
	Arr.getSomes(
		Arr.map([...history, { provider: phiProvider, id: phiId }], ({ provider, id }) =>
			Option.fromUndefinedOr(ctx.modelRegistry.find(provider, id)),
		),
	);

const firstSelected = (candidates: ReadonlyArray<Model<Api>>, setModel: SetModel) =>
	Effect.findFirst(candidates, (model) => Effect.promise(() => setModel(model)));

const restore = Effect.fn("restore")(function* ({
	selected,
	previous,
	ctx,
	setModel,
}: {
	readonly selected: Model<Api> | undefined;
	readonly previous: Model<Api> | undefined;
	readonly ctx: SelectionContext;
	readonly setModel: SetModel;
}) {
	const branch = ctx.sessionManager.getBranch();
	const history = [...Arr.filter(Arr.fromNullishOr(previous), isProtected), ...Arr.reverse(protectedHistory(branch))];

	if (isProtected(selected) || !Arr.isArrayNonEmpty(history) || !holdsContent(branch)) {
		return;
	}

	const restored = yield* firstSelected(candidatesOf(ctx, history), setModel);

	if (Option.isNone(restored)) {
		ctx.ui.notify(
			"This session may hold PHI, and no protected model could be selected. Send nothing in it.",
			"error",
		);

		return;
	}

	const { provider, id } = restored.value;

	ctx.ui.notify(
		`This session may hold PHI, so it runs on ${provider}/${id}. Start a new session for another model.`,
		"warning",
	);
});

export const keepProtected = ({
	event,
	ctx,
	setModel,
}: {
	readonly event: ModelSelectEvent;
	readonly ctx: SelectionContext;
	readonly setModel: SetModel;
}) => restore({ selected: event.model, previous: event.previousModel, ctx, setModel });

/** Pi's `--model` flag and its fallback when a selection cannot be restored both set the model with no `model_select`. */
export const keepProtectedOnStart = ({
	ctx,
	setModel,
}: {
	readonly ctx: SelectionContext & { readonly model: Model<Api> | undefined };
	readonly setModel: SetModel;
}) => restore({ selected: ctx.model, previous: undefined, ctx, setModel });
