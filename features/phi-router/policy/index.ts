/** The v1 corpus types, kept only for the v1 manifest and its generators until the v2 manifest replaces them. */
import * as Schema from "effect/Schema";

export type Part =
	| { readonly kind: "text"; readonly text: string }
	/** `data` is the base64 payload. */
	| { readonly kind: "image"; readonly mimeType: string; readonly data: string };

export interface Turn {
	readonly role: "system" | "user" | "assistant" | "tool";
	readonly parts: ReadonlyArray<Part>;
}

export type Transcript = ReadonlyArray<Turn>;

/** The 18 Safe Harbor classes, the strings the v1 manifest uses for `identifier`. */
export const SafeHarbor = Schema.Literals([
	"name",
	"geographic",
	"date",
	"phone",
	"fax",
	"email",
	"ssn",
	"mrn",
	"health-plan",
	"account",
	"license",
	"vehicle",
	"device",
	"url",
	"ip",
	"biometric",
	"photo",
	"other-id",
]);

export type SafeHarbor = typeof SafeHarbor.Type;
