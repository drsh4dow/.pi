import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import type { SyntheticIdentities } from "./policy/policy.ts";

export const defaultModel = "claude-opus-5-5";

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u));

const SettingsFile = Schema.Struct({
	mode: Schema.optionalKey(Schema.Literals(["shadow", "enforce", "force-baa"])),
	model: Schema.optionalKey(Schema.NonEmptyString),
	/** Folders whose sessions always run on the BAA account, whatever they hold. */
	baaRepos: Schema.Array(Schema.String).pipe(Schema.optionalKey),
	/** Lowercase hex SHA-256 digests of turn parts the scan skips: fixtures the user vouches hold no PHI. */
	fixtures: Schema.Array(Sha256Hex).pipe(Schema.optionalKey),
	/** Test identities added to the policy's list: exact values, and prefixes of tokens such as a staging client code. */
	synthetic: Schema.Struct({
		exact: Schema.Array(Schema.NonEmptyString),
		prefixes: Schema.Array(Schema.NonEmptyString),
	}).pipe(Schema.optionalKey),
});

const decodeSettingsFile = Schema.decodeUnknownOption(Schema.fromJsonString(SettingsFile));

/**
 * How the router treats a request. `force-baa`, `baa-repo` and `bad-settings` all dispatch the BAA account without a
 * scan; they differ only in why, which the lane log records.
 */
export type Mode = "shadow" | "enforce" | "force-baa" | "baa-repo" | "bad-settings";

interface Settings {
	readonly mode: Mode;
	readonly model: string;
	readonly fixtures: ReadonlySet<string>;
	readonly synthetic: SyntheticIdentities;
}

const noSynthetic: SyntheticIdentities = { exact: [], prefixes: [] };

const defaults: Settings = { mode: "shadow", model: defaultModel, fixtures: new Set(), synthetic: noSynthetic };

const isUnder = (cwd: string) => (repo: string) => {
	const root = Str.replace(/\/+$/u, "")(repo);

	return cwd === root || Str.startsWith(`${root}/`)(cwd);
};

const settingsOf = ({ text, cwd }: { readonly text: Option.Option<string>; readonly cwd: string }): Settings => {
	if (Option.isNone(text)) {
		return defaults;
	}

	const file = decodeSettingsFile(text.value);

	if (Option.isNone(file)) {
		return { ...defaults, mode: "bad-settings" };
	}

	const { mode = "shadow", model = defaultModel, baaRepos = [], fixtures = [], synthetic = noSynthetic } = file.value;

	return {
		mode: Arr.some(baaRepos, isUnder(cwd)) ? "baa-repo" : mode,
		model,
		fixtures: new Set(fixtures),
		synthetic,
	};
};

/** Read on every request, so a change applies to the next one without a restart. A file that cannot be read fails closed. */
export const readSettings = Effect.fn("readSettings")(
	function* (cwd: string) {
		const home = yield* Config.String("HOME");
		const fs = yield* FileSystem.FileSystem;

		const text = yield* fs.readFileString(`${home}/.pi/agent/phi-router.json`).pipe(
			Effect.asSome,
			Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
		);

		return settingsOf({ text, cwd });
	},
	Effect.catchCause(() => Effect.succeed<Settings>({ ...defaults, mode: "bad-settings" })),
);
