import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";

import { SafeHarbor, type Transcript, type Turn } from "../policy/index.ts";

export const Carrier = Schema.Literals([
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
	"screenshot",
]);

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

export const Entry = Schema.Literals(["user", "tool-result", "file-read", "steering", "compaction-summary"]);

export const Negative = Schema.Literals([
	"schema-only",
	"medical-terms",
	"public-figure",
	"look-alike",
	"test-fixture",
]);

const Role = Schema.Literals(["system", "user", "assistant", "tool"]);

export const Message = Schema.Union([
	Schema.Struct({ role: Role, text: Schema.String }),
	Schema.Struct({ role: Role, image: Schema.Struct({ mimeType: Schema.String, data: Schema.String }) }),
]);

export type Message = typeof Message.Type;

const Canary = Schema.String.check(Schema.isMinLength(8));

export const PhiCase = Schema.Struct({
	id: Schema.String,
	expect: Schema.Literal("phi"),
	strata: Schema.Struct({ identifier: SafeHarbor, carrier: Carrier, transform: Transform, entry: Entry }),
	canaries: Schema.NonEmptyArray(Canary),
	messages: Schema.NonEmptyArray(Message),
});

export type PhiStrata = (typeof PhiCase.Type)["strata"];

export const CleanCase = Schema.Struct({
	id: Schema.String,
	expect: Schema.Literal("clean"),
	strata: Schema.Struct({ negative: Negative }),
	canaries: Schema.Tuple([]),
	messages: Schema.NonEmptyArray(Message),
});

export const Case = Schema.Union([PhiCase, CleanCase]);

export type Case = typeof Case.Type;

export const CaseFromJsonLine = Schema.fromJsonString(Case);

const turnOf = (message: Message): Turn =>
	"text" in message
		? { role: message.role, parts: [{ kind: "text", text: message.text }] }
		: { role: message.role, parts: [{ kind: "image", ...message.image }] };

export const transcriptOf = (messages: ReadonlyArray<Message>): Transcript => Arr.map(messages, turnOf);
