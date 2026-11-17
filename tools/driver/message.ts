/** A prompt or steering message as a scenario writes it, and as pi's RPC takes it. */
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";

/** An image pi attaches to a prompt or a steering message, in pi's `ImageContent` shape. */
export interface Image {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

/** What a prompt or a steering message carries: its text, or its text and images. */
export type Message = string | { readonly text: string; readonly images: ReadonlyArray<Image> };

/** A message as pi's RPC takes it, with `images` only when there are some. */
export interface Sent {
	readonly message: string;
	readonly images?: ReadonlyArray<Image>;
}

export const sentOf = (message: Message): Sent => {
	if (Predicate.isString(message)) {
		return { message };
	}

	return Arr.isReadonlyArrayNonEmpty(message.images)
		? { message: message.text, images: message.images }
		: { message: message.text };
};

export const textOf = (message: Message) => sentOf(message).message;
