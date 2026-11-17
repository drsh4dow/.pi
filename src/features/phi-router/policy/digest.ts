import * as Context from "effect/Context";
import * as Encoding from "effect/encoding";
import { hash } from "fast-sha256";

const encoder = new TextEncoder();

/**
 * Hex SHA-256 of `text` as UTF-8. Synchronous, because the lane border keys messages inside a provider's stream call,
 * where WebCrypto's promise does not fit.
 */
export const sha256 = (text: string) => Encoding.Hex.encode(hash(encoder.encode(text)));

/**
 * Hex SHA-256 digests of the text parts registered as fixtures. A part whose exact text has one is neither ruled on nor
 * judged. Unprovided, the registry is empty and exempts nothing.
 */
export const Fixtures = Context.Reference<ReadonlySet<string>>("pi-harness/features/phi-router/policy/Fixtures", {
	defaultValue: () => new Set(),
});
