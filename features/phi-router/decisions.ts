import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";

import { Judge, JudgeFailed, SafeHarbor, threshold, type JudgeInput } from "./policy/index.ts";

export type Classify = (
	context: ClassifierContext,
	options: { readonly timeoutMs: number },
) => Promise<ClassifierResult>;

export const decisionsModel = "gpt-6-luna";

/** The Decisions classifier holds about 900k tokens; 2M characters stays inside it. */
export const maxChars = 2_000_000;

const timeoutMs = 20_000;

const phiQuestion = {
	type: "bool",
	instructions:
		"`fresh` is new content from a software developer's session with a coding agent: messages, pasted text, tool and file output. `seen` is earlier content of the same session, for context only. Does `fresh`, read with `seen`, contain protected health information: a value that identifies a person (name, address or place smaller than a state, a date tied to the person other than a year, phone, fax, email, SSN, medical record, health plan or account number, license, vehicle or device id, URL, IP address, biometric, photo, or any other unique code) together with, or inside a record about, that person's health, care, treatment, insurance or payment for care? One such value with health data is enough. A number, code, id or biometric template that sits beside a specific diagnosis, medication or procedure, in a record, file name, path, log or error, identifies a person unless it is clearly a placeholder. Encoded, split, misspelled, foreign-language, minified and buried data counts. Field names, column lists, types and empty templates are not values. Well-known placeholder people and values (John or Jane Doe, Richard Roe, Test Patient, 555-01xx phones, 000-00-0000, 123-45-6789 or repeated-digit SSNs) are not a person. Message acknowledgements with no patient segment, drug product codes and lots, and ids in ordinary application logs with no health data are not PHI.",
	criteria: {
		true: "It contains, or likely contains, an identifying value of a specific person together with health, care or payment-for-care data. When a real-looking person's data is present and you are unsure, true.",
		false: "It contains no identifying value of a person tied to health data: code, schemas, field names without values, generic medical terms, placeholder fixtures, acknowledgements, product codes, or public figures with no health record.",
	},
} as const;

/**
 * Asked beside `phi` because the judge reads an unfamiliar id (a prescription or claim number) as no identifier at all,
 * while it reliably sees that a row or note is one patient's own care.
 */
const recordQuestion = {
	type: "bool",
	instructions:
		"`fresh` is new content from a software developer's session with a coding agent; `seen` is earlier content of the same session, for context only. Does `fresh`, read with `seen`, contain a filled-in data record about a patient (a row, entry, message, note, claim, file name or log line) that attaches a diagnosis, medication, procedure, test result, device, biometric or payment for care to that one patient through any id, number, code, name or date? Only filled-in values count: field names, column headers, types and empty templates do not, and neither does an acknowledgement or status message that carries only message ids, codes and timestamps. Records about drug products, lots, institutions or providers are not about a patient. Placeholder fixture people (John or Jane Doe, Richard Roe, Foo Bar, Test Patient, with 555-01xx phones or SSNs such as 000-00-0000 or 123-45-6789) are not patients. Encoded, split, misspelled, foreign-language, minified and buried data counts.",
	criteria: {
		true: "It contains, or likely contains, a filled-in record about one patient, even when the only link to the patient is a number or a code.",
		false: "It contains no filled-in record about a patient: code, schemas and field names without values, reference tables of codes, drugs, products or institutions, generic medical text, placeholder fixtures, acknowledgements, aggregates, or public figures.",
	},
} as const;

/**
 * Asked beside `phi` and `record` because content is judged as it arrives: a record cut off after its first value
 * identifies a person before the health detail that would make `phi` true has been sent.
 */
const patientDataQuestion = {
	type: "bool",
	instructions:
		"`fresh` is new content from a software developer's session with a coding agent; `seen` is earlier content of the same session, for context only. Content can be cut off at a message boundary, so read `fresh` as the start of whatever it belongs to, and the output of a command that `seen` shows fetching a note, record, claim or file as that content, whatever its first line looks like. Read with `seen`, could `fresh` be content taken from a health organization's records about individual patients or members (a clinical note or its header, a claim, a member eligibility or remittance file, a log line or error about one rejected patient or claim record, or a listing of a patient export whose file names may name or number a patient), and does `fresh` hold any value from that content (a name, medical record, member, account or claim number, SSN, driver or other license number, date, address, phone, email, device, vehicle or IP address, biometric template, photo or photo file name, or another id), even a few characters cut off mid-value? Not such content: code, schemas, table definitions, models and migrations (they name fields and hold no values), field names, column headers, empty templates, a request or command that only names a file, documentation, drug products, NDCs, lots and formularies, interface acknowledgements, provider or institution directories, application logs that carry only request, account, build or job ids, aggregates such as counts by month or code with no row per person, and placeholder fixture people (John or Jane Doe, Richard Roe, Foo Bar, Test Patient, with 555-01xx phones or SSNs such as 000-00-0000, 123-45-6789 or 999-99-9999).",
	criteria: {
		true: "`fresh` holds, or may well hold, a value, whole or partial, from a health organization's records about individual patients or members.",
		false: "`fresh` holds no value from records about individual patients or members: code, schemas, field names, documentation, product or provider data, operational logs, aggregates, placeholder fixtures, or data outside health care.",
	},
} as const;

const categoryQuestion = {
	type: "choice",
	instructions: "Which kind of identifier in `fresh` most ties it to a specific person?",
	criteria: Rec.fromEntries([
		...Arr.map(SafeHarbor.literals, (literal) => [literal, `A ${literal} identifier`] as const),
		["none", "No identifier of a person"] as const,
	]),
} as const;

const categoryOf = (result: ClassifierResult) => {
	const answer = result.answers["category"];

	return answer?.type === "choice" ? Schema.decodeUnknownOption(SafeHarbor)(answer.choice) : Option.none();
};

/**
 * Decisions refuses a request whole when it refuses any one question, and it refuses the category question on some
 * clean content, such as pi's own system prompt. So the verdict is asked alone, and the category only once it taints.
 */
export const questions = {
	verdict: { phi: phiQuestion, record: recordQuestion, patientData: patientDataQuestion },
	category: { category: categoryQuestion },
};

/** The Decisions parser in pi rejects non-finite numbers but passes any finite one, such as -1, which would read as clean. */
const isProbability = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

const probabilityOf = (result: ClassifierResult, question: string) => {
	const answer = result.answers[question];

	return answer?.type === "bool" ? Option.filter(Option.some(answer.probability), isProbability) : Option.none();
};

const pPhiOf = (result: ClassifierResult) => {
	const probabilities = Arr.map(Rec.keys(questions.verdict), (question) => probabilityOf(result, question));

	return Option.map(Option.all(probabilities), (found) => Math.max(...found));
};

const classifyWith = (classify: Classify, asked: ClassifierContext["questions"]) => (input: JudgeInput) =>
	Effect.tryPromise({
		try: () => classify({ state: { seen: input.seen, fresh: input.fresh }, questions: asked }, { timeoutMs }),
		catch: () => JudgeFailed.make({ why: "error" }),
	}).pipe(
		Effect.flatMap((result) => {
			if (result.stopReason === "aborted") {
				return Effect.fail(JudgeFailed.make({ why: "timeout" }));
			}

			return result.stopReason === "stop" ? Effect.succeed(result) : Effect.fail(JudgeFailed.make({ why: "error" }));
		}),
	);

const ask = (classify: Classify) => {
	const verdictOf = classifyWith(classify, questions.verdict);
	const categoryIn = classifyWith(classify, questions.category);

	return (input: JudgeInput) =>
		Effect.gen(function* () {
			const verdict = yield* verdictOf(input);

			const pPhi = yield* Effect.fromOption(pPhiOf(verdict)).pipe(
				Effect.mapError(() => JudgeFailed.make({ why: "error" })),
			);

			if (pPhi < threshold) {
				return { pPhi, category: Option.none() };
			}

			const category = yield* Effect.option(categoryIn(input));

			return { pPhi, category: Option.flatMap(category, categoryOf) };
		});
};

export const decisionsJudge = (classify: Classify) => Layer.succeed(Judge, { maxChars, ask: ask(classify) });
