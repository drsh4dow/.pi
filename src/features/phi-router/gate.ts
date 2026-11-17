import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { accounts, isBaaAccount } from "#src/features/claude-accounts/index.ts";

export const phiProvider = "phi";

/** The `phi` model whose id follows `settings.model`, read per request. */
export const autoId = "auto";

type Selection = Pick<Model<Api>, "provider" | "id">;

type Account = (typeof accounts)[number];

type PersonalAccountOf = Extract<Account, { readonly baa: false }>;

export type PersonalAccount = PersonalAccountOf["id"];

const isPersonalAccountOf = (account: Account): account is PersonalAccountOf => !account.baa;

/** The Claude accounts outside the BAA, in `accounts` order. */
export const personalAccounts: ReadonlyArray<PersonalAccount> = Arr.map(
	Arr.filter(accounts, isPersonalAccountOf),
	({ id }) => id,
);

/** The pi-ai builtin chat providers that a protected process reaches only through the border. */
export const borderedBuiltins = ["openai", "opencode-go"] as const;

/** A provider outside the BAA that a protected process reaches only through the border. */
export type Personal = PersonalAccount | (typeof borderedBuiltins)[number];

/** The clean lane walks this order after home. */
export const personalProviders: ReadonlyArray<Personal> = [...personalAccounts, ...borderedBuiltins];

/** Where a request can land. */
export type Carrier = Personal | "ent";

/** Any model of the `phi` provider routes by content. */
export const isPhi = (model: Selection | undefined) => model !== undefined && model.provider === phiProvider;

/** The model id a `phi` selection asks for: `auto` asks for `fallback`, which is `settings.model`, any other id for itself. */
export const askedId = ({ selected, fallback }: { readonly selected: string; readonly fallback: string }) =>
	selected === autoId ? fallback : selected;

/** One physical model. */
export interface Placement {
	readonly provider: Carrier;
	readonly id: string;
}

export type Carries = (provider: Carrier, id: string) => boolean;

/**
 * Where sealed content of `id` runs: `ent/<id>` when `ent` carries it, else `ent/<fallback>`. A placement whose id
 * differs from the asked id is a substitute.
 */
export const sealedLane = ({
	id,
	fallback,
	carries,
}: {
	readonly id: string;
	readonly fallback: string;
	readonly carries: Carries;
}): Placement => ({ provider: "ent", id: carries("ent", id) ? id : fallback });

/** A session that may hold PHI: one that routes by content, or one already on a BAA account. */
export const isProtected = (model: Selection | undefined) =>
	isPhi(model) || (model !== undefined && isBaaAccount(model.provider));

export type Wanted =
	| { readonly kind: "alias"; readonly id: string }
	| { readonly kind: "key"; readonly provider: string; readonly id: string };

type ModelKey = `${string}/${string}`;

export type Target =
	| { readonly kind: "open" }
	| { readonly kind: "run"; readonly key: ModelKey }
	| { readonly kind: "refuse"; readonly why: string };

export interface DelegateRequest {
	readonly parent: Selection | undefined;
	/** The parent runs wholly on the BAA account: pinned, `force-baa`, `baa-repo`, bad settings, or `shadow`. */
	readonly held: boolean;
	readonly wanted: Wanted;
	readonly dispatchModel: string;
	readonly has: (key: ModelKey) => boolean;
}

const isPersonalAccount = (provider: string) => Arr.some(personalAccounts, (account) => account === provider);

const fromPhi = ({ held, wanted, dispatchModel }: DelegateRequest): Target => {
	if (wanted.kind === "key" && isBaaAccount(wanted.provider)) {
		return { kind: "run", key: `${wanted.provider}/${wanted.id}` };
	}

	if (wanted.kind === "alias" || wanted.provider === phiProvider || isPersonalAccount(wanted.provider)) {
		return { kind: "run", key: held ? `ent/${dispatchModel}` : `${phiProvider}/${autoId}` };
	}

	return {
		kind: "refuse",
		why: `a delegate of a ${phiProvider}/${autoId} session runs on ${phiProvider}/${autoId} or a BAA account, and ${wanted.provider}/${wanted.id} is neither`,
	};
};

const fromBaa = (account: string, { wanted, dispatchModel, has }: DelegateRequest): Target => {
	if (wanted.kind === "alias") {
		const own: ModelKey = `${account}/${wanted.id}`;

		return { kind: "run", key: has(own) ? own : `${account}/${dispatchModel}` };
	}

	if (isBaaAccount(wanted.provider)) {
		return { kind: "run", key: `${wanted.provider}/${wanted.id}` };
	}

	return {
		kind: "refuse",
		why: `a delegate of a session on the BAA account ${account} runs on a BAA account, and ${wanted.provider}/${wanted.id} is not one`,
	};
};

/**
 * Where a delegate of a protected session runs. From `phi/auto`, every alias and personal or `phi` model runs on
 * `phi/auto`, where its own requests are judged, or on the BAA account when the parent is held there. From a BAA account, the delegate stays on a BAA
 * account. Nothing else is allowed, since an alias's home provider is outside the boundary.
 */
export const delegateTarget = (request: DelegateRequest): Target => {
	const { parent } = request;

	if (parent === undefined) {
		return { kind: "open" };
	}

	if (isPhi(parent)) {
		return fromPhi(request);
	}

	return isBaaAccount(parent.provider) ? fromBaa(parent.provider, request) : { kind: "open" };
};

const unicodeEscape = /(?<escape>\\u\{[\dA-Fa-f]+\}|\\u[\dA-Fa-f]{4})/u;

const escapedPoint = /^\\u\{?(?<hex>[\dA-Fa-f]+)\}?$/u;

const unescapedPiece = (piece: string) => {
	const point = Number.parseInt(escapedPoint.exec(piece)?.groups?.["hex"] ?? "", 16);

	return Number.isNaN(point) || point > 1_114_111 ? piece : String.fromCodePoint(point);
};

const unescaped = (code: string) => Arr.join(Arr.map(Str.split(code, unicodeEscape), unescapedPiece), "");

const modelReach = /\b(?<name>models|globalThis|self|Reflect|eval|Function)\b|\b(?<dynamic>import)\s*\(/u;

/**
 * The name that makes a codemode script unsafe in a protected session, if any. It guards against a model that reaches
 * `models` by accident, not against an adversary.
 */
const unsafeReach = (code: string) =>
	Option.fromNullishOr(modelReach.exec(unescaped(code))?.groups).pipe(
		Option.map(({ name, dynamic }) => name ?? `${dynamic ?? "import"}(`),
	);

const CodemodeInput = Schema.Struct({ code: Schema.String });

const decodeCodemodeInput = Schema.decodeUnknownOption(CodemodeInput);

const reachOf = (input: ToolCallEvent["input"]) =>
	Option.match(decodeCodemodeInput(input), {
		onNone: () => Option.some("an input without code"),
		onSome: ({ code }) => unsafeReach(code),
	});

/** Blocks a codemode script that can reach classifier or image models, whose calls bypass the router, in a protected session. */
export const guardCodemode = ({
	event,
	ctx,
}: {
	readonly event: ToolCallEvent;
	readonly ctx: Pick<ExtensionContext, "model">;
}) => {
	const reach = event.toolName === "codemode" && isProtected(ctx.model) ? reachOf(event.input) : Option.none();

	const blocked = Option.map(reach, (name) => ({
		block: true,
		reason: `This session may hold PHI, and a codemode script that names \`${name}\` can send it to a model outside the PHI router. Call the tools directly instead.`,
	}));

	return Promise.resolve(Option.getOrUndefined(blocked));
};
