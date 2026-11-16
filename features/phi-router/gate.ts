import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { accountOf, isBaaAccount } from "../claude-accounts/index.ts";

export const phiProvider = "phi";

export const phiId = "auto";

type Selection = Pick<Model<Api>, "provider" | "id">;

export const isPhi = (model: Selection | undefined) =>
	model !== undefined && model.provider === phiProvider && model.id === phiId;

/** A session that may hold PHI: one that routes by content, or one already on a BAA account. */
export const isProtected = (model: Selection | undefined) =>
	isPhi(model) || (model !== undefined && isBaaAccount(model.provider));

export type Wanted =
	| { readonly kind: "alias"; readonly id: string }
	| { readonly kind: "key"; readonly provider: string; readonly id: string };

export type ModelKey = `${string}/${string}`;

export type Target =
	| { readonly kind: "open" }
	| { readonly kind: "run"; readonly key: ModelKey }
	| { readonly kind: "refuse"; readonly why: string };

interface DelegateRequest {
	readonly parent: Selection | undefined;
	/** The parent runs wholly on the BAA account: pinned, `force-baa`, `baa-repo`, bad settings, or `shadow`. */
	readonly held: boolean;
	readonly wanted: Wanted;
	readonly dispatchModel: string;
	readonly has: (key: ModelKey) => boolean;
}

const isPersonal = (provider: string) => Option.exists(accountOf(provider), ({ baa }) => !baa);

const fromPhi = ({ held, wanted, dispatchModel }: DelegateRequest): Target => {
	if (wanted.kind === "key" && isBaaAccount(wanted.provider)) {
		return { kind: "run", key: `${wanted.provider}/${wanted.id}` };
	}

	if (wanted.kind === "alias" || wanted.provider === phiProvider || isPersonal(wanted.provider)) {
		return { kind: "run", key: held ? `ent/${dispatchModel}` : `${phiProvider}/${phiId}` };
	}

	return {
		kind: "refuse",
		why: `a delegate of a ${phiProvider}/${phiId} session runs on ${phiProvider}/${phiId} or a BAA account, and ${wanted.provider}/${wanted.id} is neither`,
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
export const unsafeReach = (code: string) =>
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
