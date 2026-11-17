import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { accounts } from "#src/features/claude-accounts/index.ts";

export const phiProvider = "phi";

/** The `phi` model whose id follows `settings.model`, read per request. */
export const autoId = "auto";

type Selection = Pick<Model<Api>, "provider" | "id">;

type Account = (typeof accounts)[number];

export type PersonalAccount = Extract<Account, { readonly baa: false }>["id"];

/** The Claude accounts outside the BAA, in `accounts` order. */
export const personalAccounts: ReadonlyArray<PersonalAccount> = Arr.flatMap(accounts, (account) =>
	account.baa ? [] : [account.id],
);

/** The pi-ai builtin chat providers outside the BAA, which a protected process reaches only through the border. */
export const borderedBuiltins = ["opencode-go"] as const;

/** The pi-ai builtin chat providers under the BAA, which receive sealed content as it is. */
const baaBuiltins = ["openai"] as const;

/** A provider outside the BAA that a protected process reaches only through the border. */
export type Personal = PersonalAccount | (typeof borderedBuiltins)[number];

/** A provider under the BAA, which may receive sealed content. */
type Baa = Extract<Account, { readonly baa: true }>["id"] | (typeof baaBuiltins)[number];

/** The clean lane walks this order after home. */
export const personalProviders: ReadonlyArray<Personal> = [...personalAccounts, ...borderedBuiltins];

/** The sealed lane takes the first of these that carries the id. */
export const baaProviders: ReadonlyArray<Baa> = [
	...Arr.flatMap(accounts, (account) => (account.baa ? [account.id] : [])),
	...baaBuiltins,
];

export const isPersonal = (provider: string): provider is Personal =>
	Arr.some(personalProviders, (personal) => personal === provider);

export const isBaa = (provider: string): provider is Baa => Arr.some(baaProviders, (baa) => baa === provider);

/** Where a request can land. */
export type Carrier = Personal | Baa;

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
 * Where sealed content of `id` runs: the first BAA provider that carries it, else `ent/<fallback>`. A placement whose
 * id differs from the asked id is a substitute.
 */
export const sealedLane = ({
	id,
	fallback,
	carries,
}: {
	readonly id: string;
	readonly fallback: string;
	readonly carries: Carries;
}): Placement =>
	Option.match(
		Arr.findFirst(baaProviders, (provider) => carries(provider, id)),
		{ onNone: (): Placement => ({ provider: "ent", id: fallback }), onSome: (provider) => ({ provider, id }) },
	);

/** A session that may hold PHI: one that routes by content, or one already on a BAA provider. */
export const isProtected = (model: Selection | undefined) =>
	isPhi(model) || (model !== undefined && isBaa(model.provider));

export type Wanted =
	| { readonly kind: "alias"; readonly id: string }
	| { readonly kind: "key"; readonly provider: string; readonly id: string };

type ModelKey = `${string}/${string}`;

/** How a parent session stands toward PHI: `routing` and `held` are on a `phi` model, `held` runs wholly on ent. */
export type Standing = "open" | "routing" | "held" | "baa";

export type Target =
	| { readonly kind: "open" }
	| { readonly kind: "run"; readonly key: ModelKey }
	/** The whole run lands on `key` because no BAA provider carries the model id `missing`. */
	| { readonly kind: "substitute"; readonly key: ModelKey; readonly missing: string }
	| { readonly kind: "refuse"; readonly why: string };

export interface DelegateRequest {
	readonly standing: Standing;
	readonly wanted: Wanted;
	/** `settings.model`, which the sealed lane runs when no BAA provider carries the wanted id. */
	readonly fallback: string;
	/** Whether the registry has the model id on the provider. */
	readonly carries: Carries;
}

/**
 * A `phi` parent routes, or is held when it runs wholly on ent: pinned, `force-baa`, `baa-repo`, bad settings, or
 * `shadow`. A parent on a BAA provider is `baa`. Any other parent is open.
 */
export const standingOf = ({
	parent,
	held,
}: {
	readonly parent: Selection | undefined;
	readonly held: boolean;
}): Standing => {
	if (isPhi(parent)) {
		return held ? "held" : "routing";
	}

	return parent !== undefined && isBaa(parent.provider) ? "baa" : "open";
};

type Spelled = Extract<Wanted, { readonly kind: "key" }>;

const asNamed = ({ provider, id }: Spelled): Target => ({ kind: "run", key: `${provider}/${id}` });

const refused = (why: string): Target => ({ kind: "refuse", why });

/** The sealed lane of `id`: it runs there, or the whole run lands on the substitute. */
const onSealedLane = (id: string, { fallback, carries }: DelegateRequest): Target => {
	const lane = sealedLane({ id, fallback, carries });
	const key: ModelKey = `${lane.provider}/${lane.id}`;

	return lane.id === id ? { kind: "run", key } : { kind: "substitute", key, missing: id };
};

/**
 * An id a personal provider carries runs as `phi/<id>`, whose requests are judged one by one. Any other id has no
 * personal provider to route to, so it runs on its sealed lane.
 */
const fromRouting = (request: DelegateRequest): Target => {
	const { wanted, carries } = request;

	if (wanted.kind === "key" && wanted.provider === phiProvider) {
		return asNamed(wanted);
	}

	if (wanted.kind === "key" && !isPersonal(wanted.provider)) {
		return refused(
			`a delegate of a session that routes PHI runs on a phi model, a BAA provider or a personal one, and ${wanted.provider}/${wanted.id} is none of them`,
		);
	}

	return Arr.some(personalProviders, (provider) => carries(provider, wanted.id))
		? { kind: "run", key: `${phiProvider}/${wanted.id}` }
		: onSealedLane(wanted.id, request);
};

/** A spelled personal model means that model, so it runs on its sealed lane only when the lane keeps the same id. */
const keptOnSealedLane = (wanted: Spelled, request: DelegateRequest): Target => {
	const kept = onSealedLane(wanted.id, request);

	return kept.kind === "run"
		? kept
		: refused(
				`a delegate of a session held on the BAA account runs on a BAA provider, and none carries ${wanted.id}, which ${wanted.provider}/${wanted.id} names`,
			);
};

const fromHeld = (request: DelegateRequest): Target => {
	const { wanted, fallback } = request;

	if (wanted.kind === "alias" || wanted.provider === phiProvider) {
		return onSealedLane(askedId({ selected: wanted.id, fallback }), request);
	}

	return isPersonal(wanted.provider)
		? keptOnSealedLane(wanted, request)
		: refused(
				`a delegate of a session held on the BAA account runs on a BAA provider, and ${wanted.provider}/${wanted.id} is not one`,
			);
};

/** A session on a BAA provider never routes, so only an alias or a BAA model runs. */
const fromBaa = (request: DelegateRequest): Target => {
	const { wanted } = request;

	return wanted.kind === "alias"
		? onSealedLane(wanted.id, request)
		: refused(
				`a delegate of a session on a BAA provider runs on a BAA provider, and ${wanted.provider}/${wanted.id} is not one`,
			);
};

/**
 * Where a delegate of a parent with this standing runs. The alias or spelled key picks the model id, and a protected
 * parent's delegate runs a spelled BAA model as named. A routing parent's delegate runs an id a personal provider
 * carries as `phi/<id>`, so the content of each request picks the provider. Any other id, and every id of a held or
 * BAA parent's delegate, runs on its sealed lane, or on the substitute when no BAA provider carries the id.
 */
export const delegateTarget = (request: DelegateRequest): Target => {
	const { standing, wanted } = request;

	if (standing !== "open" && wanted.kind === "key" && isBaa(wanted.provider)) {
		return asNamed(wanted);
	}

	switch (standing) {
		case "open": {
			return { kind: "open" };
		}

		case "routing": {
			return fromRouting(request);
		}

		case "held": {
			return fromHeld(request);
		}

		case "baa": {
			return fromBaa(request);
		}

		default: {
			const unhandled: never = standing;

			return unhandled;
		}
	}
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
