import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";

export const TextIdentifier = Schema.Literals([
	"patient-name",
	"ssn",
	"birth-date",
	"street-address",
	"personal-phone",
	"personal-email",
	"member-number",
	"medicare-medicaid-number",
	"mrn",
	"driver-license",
	"passport",
]);

export type TextIdentifier = typeof TextIdentifier.Type;

export const Identifier = Schema.Literals([...TextIdentifier.literals, "face-photo"]);

export const TextCarrier = Schema.Literals([
	"sql-dump",
	"csv",
	"fhir-json",
	"hl7v2",
	"x12-837",
	"log-line",
	"stack-trace",
	"clinical-note",
	"ticket",
	"git-diff",
	"file-name",
]);

export type TextCarrier = typeof TextCarrier.Type;

export const Carrier = Schema.Literals([...TextCarrier.literals, "screenshot"]);

export const Transform = Schema.Literals([
	"plain",
	"base64",
	"gzip-hex",
	"split",
	"buried",
	"minified",
	"non-english",
	"typos",
]);

export const Entry = Schema.Literals([
	"user",
	"tool-result",
	"file-read",
	"steering",
	"compaction-summary",
	"ent-reply",
]);

export const Negative = Schema.Literals([
	"schema-only",
	"medical-terms",
	"public-figure",
	"look-alike",
	"internal-id",
	"internal-id-health",
	"synthetic-listed",
	"staff-contact",
	"fragment",
	"count",
	"clean-screenshot",
]);

const Role = Schema.Literals(["system", "user", "assistant", "tool"]);

export const Message = Schema.Union([
	Schema.Struct({ role: Role, text: Schema.String }),
	Schema.Struct({ role: Role, image: Schema.Struct({ mimeType: Schema.String, data: Schema.String }) }),
]);

export type Message = typeof Message.Type;

const Canary = Schema.String.check(Schema.isMinLength(8));

/** A partial identifier planted on purpose: reported when it reaches a personal account, never a leak. */
const Fragment = Schema.String.check(Schema.isMinLength(6));

const CanaryParts = Schema.Record(Schema.String, Schema.NonEmptyArray(Schema.String));

export const PhiCase = Schema.Struct({
	id: Schema.String,
	expect: Schema.Literal("phi"),
	strata: Schema.Struct({ identifier: Identifier, carrier: Carrier, transform: Transform, entry: Entry }),
	canaries: Schema.NonEmptyArray(Canary),
	/** For a `split` case: each cut canary's parts, in message order. The case leaks when every part reaches a personal account. */
	canaryParts: Schema.optionalKey(CanaryParts),
	fragments: Schema.Array(Fragment),
	messages: Schema.NonEmptyArray(Message),
});

export type PhiStrata = (typeof PhiCase.Type)["strata"];

export const CleanCase = Schema.Struct({
	id: Schema.String,
	expect: Schema.Literal("clean"),
	strata: Schema.Struct({ negative: Negative }),
	canaries: Schema.Tuple([]),
	fragments: Schema.Array(Fragment),
	messages: Schema.NonEmptyArray(Message),
});

export const Case = Schema.Union([PhiCase, CleanCase]);

export type Case = typeof Case.Type;

export const CaseFromJsonLine = Schema.fromJsonString(Case);

export const Synthetic = Schema.Struct({ exact: Schema.Array(Schema.String), prefixes: Schema.Array(Schema.String) });

export type Synthetic = typeof Synthetic.Type;

export type Part =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "image"; readonly mimeType: string; readonly data: string };

export interface Turn {
	readonly role: Message["role"];
	readonly parts: ReadonlyArray<Part>;
}

export type Transcript = ReadonlyArray<Turn>;

const turnOf = (message: Message): Turn =>
	"text" in message
		? { role: message.role, parts: [{ kind: "text", text: message.text }] }
		: { role: message.role, parts: [{ kind: "image", ...message.image }] };

export const transcriptOf = (messages: ReadonlyArray<Message>): Transcript => Arr.map(messages, turnOf);
