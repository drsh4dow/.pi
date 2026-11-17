import * as Effect from "effect/Effect";
import type * as Headers from "effect/http/Headers";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

import { WebError } from "./page.ts";

export interface Fetched {
	readonly status: number;
	readonly finalUrl: string;
	readonly mime: string;
	readonly headers: Headers.Headers;
	readonly bytes: Uint8Array;
}

export const mimeOf = (headers: Headers.Headers) => {
	const [type] = Str.split(headers["content-type"] ?? "", ";");

	return Str.toLowerCase(Str.trim(type));
};

const charsetOf = (headers: Headers.Headers) =>
	Option.fromNullishOr(/charset="?(?<label>[^";\s]+)/iu.exec(headers["content-type"] ?? "")?.groups?.["label"]);

/** Bun types TextDecoder's label as its list of encoding names, and an unknown name throws. */
const isEncoding = (label: string): label is Bun.Encoding =>
	Option.getOrElse(
		Option.liftThrowable(() => Reflect.construct(TextDecoder, [label]) instanceof TextDecoder)(),
		() => false,
	);

export const textOf = (page: Fetched): string => {
	const charset = Option.filter(charsetOf(page.headers), isEncoding);

	return new TextDecoder(Option.getOrUndefined(charset)).decode(page.bytes);
};

export const decoded =
	<Value>(schema: Schema.Decoder<Value>) =>
	(page: Fetched): Effect.Effect<Value, WebError> =>
		Schema.decodeEffect(Schema.fromJsonString(schema))(textOf(page)).pipe(
			Effect.mapError(() => WebError.make({ kind: "bad-answer", message: `${page.finalUrl}: unexpected answer` })),
		);
