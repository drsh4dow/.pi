import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";

export const providersOf = (entries: ReadonlyArray<SessionEntry>) =>
	Arr.flatMap(entries, (entry) =>
		entry.type === "message" && entry.message.role === "assistant" ? [entry.message.provider] : [],
	);
