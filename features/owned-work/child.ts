import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import type { RunSpec } from "../../clients/hc/index.ts";
import type { PiCli } from "../../clients/pi-cli/index.ts";
import type { SessionAddress } from "../../clients/pi-sessions/index.ts";
import { type Delegate, DelegateName, type Entry } from "./delegates.ts";

export const Role = Schema.Literals(["root", "owner", "leaf"]);

export type Role = typeof Role.Type;

export const ChildEnv = Schema.Struct({
	PI_OWNED_WORK_ROLE: Schema.Literals(["owner", "leaf"]),
	PI_OWNED_WORK_DELEGATES: Schema.optionalKey(Schema.String),
	PI_OWNED_WORK_SLICE: Schema.String,
});

export type Self = Data.TaggedEnum<{
	Root: { readonly role: "root" };
	Child: {
		readonly role: "owner" | "leaf";
		readonly delegates: ReadonlyArray<DelegateName>;
		readonly slice: string;
	};
}>;

export const Self = Data.taggedEnum<Self>();

export const selfFromEnv = Effect.fn("selfFromEnv")(function* (env: Readonly<Record<string, string | undefined>>) {
	if (env["PI_OWNED_WORK_ROLE"] === undefined) {
		return Self.Root({ role: "root" });
	}

	const child = yield* Schema.decodeUnknownEffect(ChildEnv)(env);
	const listed = child.PI_OWNED_WORK_DELEGATES === undefined ? [] : Str.split(child.PI_OWNED_WORK_DELEGATES, ",");
	const delegates = yield* Schema.decodeEffect(Schema.Array(DelegateName))(listed);

	return Self.Child({ role: child.PI_OWNED_WORK_ROLE, delegates, slice: child.PI_OWNED_WORK_SLICE });
});

export const inheritedEnv = (env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> =>
	Rec.filterMap(env, (value, key) =>
		value === undefined || /^HC_TERMINAL_|^PI_OWNED_WORK_/u.test(key) ? Result.failVoid : Result.succeed(value),
	);

/** `dir` is the `delegates/` subfolder of the root's session folder, so `pi -c` never picks a child. */
export type ChildSession = SessionAddress;

const extensionsFolder = `${import.meta.dirname}/../../agent/extensions`;

/** The entrypoints every delegate loads first: owned-work, so it can report back, and prompt, which builds its system prompt. */
export const childExtensions: ReadonlyArray<string> = [
	`${extensionsFolder}/owned-work/index.ts`,
	`${extensionsFolder}/prompt/index.ts`,
];

/** Every agent combines tool calls with codemode, so every child gets it whatever its delegate file lists. */
const toolsOf = (config: Delegate) => Arr.union(config.tools, ["codemode"]);

export interface LaunchRequest {
	readonly entry: Entry;
	readonly message: string;
	readonly ref: string;
	readonly agentKey: string;
	readonly childSession: ChildSession;
	readonly passEnv: Readonly<Record<string, string>>;
}

export const leafRole = { nice: "1000", env: { PI_OWNED_WORK_ROLE: "leaf" } };

const roleOf = (config: Delegate) =>
	Match.value(config).pipe(
		Match.discriminatorsExhaustive("role")({
			leaf: () => leafRole,
			owner: (owner) => ({
				nice: "500",
				env: { PI_OWNED_WORK_ROLE: "owner", PI_OWNED_WORK_DELEGATES: Arr.join(owner.delegates, ",") },
			}),
		}),
	);

const terminalName = ({ entry, ref, agentKey }: LaunchRequest) => {
	const name = Str.toLowerCase(`${entry.name}-${Str.replace(/^\D*/u, "")(ref)}-${agentKey}`);

	return Str.slice(0, 32)(Str.replaceAll(/[^a-z0-9_.-]/gu, "-")(name));
};

const nameLength = 80;

export const launch = (cli: (typeof PiCli)["Service"]) => (request: LaunchRequest) => {
	const { entry, message, childSession } = request;
	const role = roleOf(entry.config);

	const child = {
		session: childSession,
		name: Str.slice(0, nameLength)(`${entry.name}: ${Arr.headNonEmpty(Str.split(message, "\n"))}`),
		message,
		loadout: { ...entry.config, tools: toolsOf(entry.config) },
	};

	return Effect.map(cli.launch(child), (argv): Pick<RunSpec, "name" | "argv" | "env"> => ({
		name: terminalName(request),
		argv: ["choom", "-n", role.nice, "--", ...argv],
		env: { ...request.passEnv, ...role.env },
	}));
};
