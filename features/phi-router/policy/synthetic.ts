import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Order from "effect/Order";
import * as Patterns from "effect/RegExp";
import * as Str from "effect/String";

import { syntheticIdentities, syntheticMark, type SyntheticIdentities } from "./policy.ts";

/** Test identities the caller adds to the policy's own list, such as from settings. Unprovided, it adds none. */
export const Synthetic = Context.Reference<SyntheticIdentities>("pi-harness/features/phi-router/policy/Synthetic", {
	defaultValue: () => ({ exact: [], prefixes: [] }),
});

const notWord = String.raw`(?<![\p{L}\p{N}_])`;

const longestFirst = Order.mapInput(Order.Number, (value: string) => -value.length);

/** Replaces every listed identity, and every token that starts with a listed prefix, with `syntheticMark`. */
export const blankerOf = (added: SyntheticIdentities) => {
	const exact = Arr.sort([...syntheticIdentities.exact, ...added.exact], longestFirst);
	const prefixes = [...syntheticIdentities.prefixes, ...added.prefixes];
	const exactly = Arr.map(exact, (value) => String.raw`${notWord}${Patterns.escape(value)}(?![\p{L}\p{N}_])`);
	const prefixed = Arr.map(prefixes, (prefix) => String.raw`${notWord}${Patterns.escape(prefix)}[\p{L}\p{N}_.@+-]*`);
	const listed = [...exactly, ...prefixed];

	if (listed.length === 0) {
		return (text: string) => text;
	}

	return Str.replaceAll(new RegExp(Arr.join(listed, "|"), "gu"), syntheticMark);
};
