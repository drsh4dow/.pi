import * as Arr from "effect/Array";

import { compactJson } from "./encodings.ts";
import { healthLabels, identifierLabels, phrases } from "./labels.ts";
import type { ByLang } from "./people.ts";
import { primaryOf, type RenderInput } from "./record.ts";

interface NoteFacts {
	readonly diagnosis: string;
	readonly code: string;
	readonly medication: string;
	readonly vitals: string;
}

type NoteBody = (facts: NoteFacts) => ReadonlyArray<string>;

const noteBodies = {
	en: ({ diagnosis, code, medication, vitals }) => [
		"Visit type: outpatient follow-up",
		"",
		"SUBJECTIVE:",
		`Returns for follow-up of ${diagnosis}. Reports taking ${medication} as prescribed. No new complaints.`,
		"",
		"OBJECTIVE:",
		`${vitals}. Alert and oriented.`,
		"",
		"ASSESSMENT:",
		`${diagnosis} (${code}), stable on current regimen.`,
		"",
		"PLAN:",
		`Continue ${medication}. Repeat labs before next visit. Return in 3 months.`,
	],
	es: ({ diagnosis, code, medication, vitals }) => [
		"Tipo de visita: control ambulatorio",
		"",
		"SUBJETIVO:",
		`Acude a control de ${diagnosis}. Refiere tomar ${medication} según indicación. Sin quejas nuevas.`,
		"",
		"OBJETIVO:",
		`${vitals}. Consciente y orientado.`,
		"",
		"EVALUACIÓN:",
		`${diagnosis} (${code}), estable con el tratamiento actual.`,
		"",
		"PLAN:",
		`Continuar ${medication}. Repetir analítica antes de la próxima visita. Control en 3 meses.`,
	],
	de: ({ diagnosis, code, medication, vitals }) => [
		"Besuchsart: ambulante Verlaufskontrolle",
		"",
		"ANAMNESE:",
		`Wiedervorstellung zur Kontrolle bei ${diagnosis}. Nimmt ${medication} wie verordnet. Keine neuen Beschwerden.`,
		"",
		"BEFUND:",
		`${vitals}. Wach und orientiert.`,
		"",
		"BEURTEILUNG:",
		`${diagnosis} (${code}), unter aktueller Therapie stabil.`,
		"",
		"PROCEDERE:",
		`${medication} fortführen. Laborkontrolle vor dem nächsten Termin. Wiedervorstellung in 3 Monaten.`,
	],
	fr: ({ diagnosis, code, medication, vitals }) => [
		"Type de visite : suivi en consultation",
		"",
		"SUBJECTIF :",
		`Revient pour le suivi de : ${diagnosis}. Dit prendre ${medication} comme prescrit. Pas de nouvelle plainte.`,
		"",
		"OBJECTIF :",
		`${vitals}. Conscient et orienté.`,
		"",
		"ÉVALUATION :",
		`${diagnosis} (${code}), stable sous traitement actuel.`,
		"",
		"PLAN :",
		`Poursuivre ${medication}. Bilan biologique avant la prochaine visite. Revoir dans 3 mois.`,
	],
	pt: ({ diagnosis, code, medication, vitals }) => [
		"Tipo de consulta: retorno ambulatorial",
		"",
		"SUBJETIVO:",
		`Retorna para acompanhamento de ${diagnosis}. Refere uso de ${medication} conforme prescrito. Sem queixas novas.`,
		"",
		"OBJETIVO:",
		`${vitals}. Lúcido e orientado.`,
		"",
		"AVALIAÇÃO:",
		`${diagnosis} (${code}), estável com o tratamento atual.`,
		"",
		"PLANO:",
		`Manter ${medication}. Repetir exames antes do próximo retorno. Retorno em 3 meses.`,
	],
	vi: ({ diagnosis, code, medication, vitals }) => [
		"Loại khám: tái khám ngoại trú",
		"",
		"CHỦ QUAN:",
		`Tái khám theo dõi ${diagnosis}. Dùng ${medication} theo đơn. Không có triệu chứng mới.`,
		"",
		"KHÁCH QUAN:",
		`${vitals}. Tỉnh táo.`,
		"",
		"ĐÁNH GIÁ:",
		`${diagnosis} (${code}), ổn định với điều trị hiện tại.`,
		"",
		"KẾ HOẠCH:",
		`Tiếp tục ${medication}. Xét nghiệm lại trước lần khám tới. Tái khám sau 3 tháng.`,
	],
} satisfies ByLang<NoteBody>;

const identifierLine = (input: RenderInput) => {
	const field = primaryOf(input.record);

	return `${identifierLabels[field.kind][input.record.lang]}: ${field.value}`;
};

export const clinicalNote = (input: RenderInput) => {
	const { record, rng, minified } = input;
	const { lang, diagnosis } = record;

	const body = noteBodies[lang]({
		diagnosis: diagnosis.text[lang],
		code: diagnosis.code,
		medication: diagnosis.medication[lang],
		vitals: `BP ${String(rng.between(108, 162))}/${String(rng.between(64, 96))}, HR ${String(rng.between(58, 104))}`,
	});

	const text = Arr.join([identifierLine(input), ...body], "\n");

	return minified ? compactJson({ noteType: "progress", status: "final", text }) : text;
};

const recordLines = (input: RenderInput) => {
	const { lang, diagnosis } = input.record;

	return [
		identifierLine(input),
		`${healthLabels.diagnosis[lang]}: ${diagnosis.code} ${diagnosis.text[lang]}`,
		`${healthLabels.medication[lang]}: ${diagnosis.medication[lang]}`,
	];
};

export const ticket = (input: RenderInput) => {
	const { record, rng, minified } = input;
	const id = rng.between(20_000, 89_999);
	const subject = phrases.ticketSubject[record.lang];
	const description = Arr.join([phrases.ticketBody[record.lang], "", ...recordLines(input)], "\n");

	if (minified) {
		return compactJson({ ticket: { id, subject, status: "open", priority: "high", description } });
	}

	return Arr.join(
		[
			`Ticket #${String(id)} (priority: high, status: open)`,
			`Subject: ${subject}`,
			"Requester: front desk, Northfield Clinic",
			"",
			description,
		],
		"\n",
	);
};

export const screenshotText = (input: RenderInput) => {
	const lines = [phrases.screen[input.record.lang], ...recordLines(input), "Status: DENIED"];

	return input.minified ? compactJson({ ocr: { lines } }) : Arr.join(lines, "\n");
};
