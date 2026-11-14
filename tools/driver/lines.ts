import * as Arr from "effect/Array";
import * as Str from "effect/String";

/**
 * Pure. Splits on LF only, dropping one CR before it. Unicode line and paragraph separators are valid inside JSON
 * strings, so a generic line splitter would cut records apart (pi's docs/rpc.md, Framing).
 */
export const lfLines = ({ carried, chunk }: { readonly carried: string; readonly chunk: string }) => {
	const parts = Str.split(`${carried}${chunk}`, "\n");
	const complete = Arr.dropRight(parts, 1);

	return {
		lines: Arr.map(complete, (line) => (Str.endsWith("\r")(line) ? Str.slice(0, -1)(line) : line)),
		rest: Arr.lastNonEmpty(parts),
	};
};
