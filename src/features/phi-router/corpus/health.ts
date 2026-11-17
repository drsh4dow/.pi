import type * as Arr from "effect/Array";

import type { ByLang } from "./people.ts";

/** The health half of a PHI record: an ICD-10-CM diagnosis and the drug that treats it. */
export interface Diagnosis {
	readonly code: string;
	readonly text: ByLang<string>;
	readonly medication: ByLang<string>;
}

export const diagnoses: Arr.NonEmptyReadonlyArray<Diagnosis> = [
	{
		code: "E11.9",
		text: {
			en: "Type 2 diabetes mellitus without complications",
			es: "Diabetes mellitus tipo 2 sin complicaciones",
			de: "Diabetes mellitus Typ 2 ohne Komplikationen",
			fr: "Diabète de type 2 sans complication",
			pt: "Diabetes mellitus tipo 2 sem complicações",
			vi: "Đái tháo đường type 2 không biến chứng",
		},
		medication: {
			en: "metformin 500 mg twice daily",
			es: "metformina 500 mg dos veces al día",
			de: "Metformin 500 mg zweimal täglich",
			fr: "metformine 500 mg deux fois par jour",
			pt: "metformina 500 mg duas vezes ao dia",
			vi: "metformin 500 mg ngày hai lần",
		},
	},
	{
		code: "I10",
		text: {
			en: "Essential hypertension",
			es: "Hipertensión esencial",
			de: "Essentielle Hypertonie",
			fr: "Hypertension essentielle",
			pt: "Hipertensão essencial",
			vi: "Tăng huyết áp vô căn",
		},
		medication: {
			en: "lisinopril 10 mg daily",
			es: "lisinopril 10 mg al día",
			de: "Lisinopril 10 mg täglich",
			fr: "lisinopril 10 mg par jour",
			pt: "lisinopril 10 mg ao dia",
			vi: "lisinopril 10 mg mỗi ngày",
		},
	},
	{
		code: "F32.1",
		text: {
			en: "Major depressive disorder, single episode, moderate",
			es: "Trastorno depresivo mayor, episodio único, moderado",
			de: "Mittelgradige depressive Episode",
			fr: "Épisode dépressif majeur, modéré",
			pt: "Transtorno depressivo maior, episódio único, moderado",
			vi: "Rối loạn trầm cảm chủ yếu, giai đoạn đơn, mức độ vừa",
		},
		medication: {
			en: "sertraline 50 mg daily",
			es: "sertralina 50 mg al día",
			de: "Sertralin 50 mg täglich",
			fr: "sertraline 50 mg par jour",
			pt: "sertralina 50 mg ao dia",
			vi: "sertraline 50 mg mỗi ngày",
		},
	},
	{
		code: "C50.911",
		text: {
			en: "Malignant neoplasm of right female breast",
			es: "Neoplasia maligna de mama derecha",
			de: "Bösartige Neubildung der rechten Brustdrüse",
			fr: "Tumeur maligne du sein droit",
			pt: "Neoplasia maligna da mama direita",
			vi: "Ung thư vú phải",
		},
		medication: {
			en: "tamoxifen 20 mg daily",
			es: "tamoxifeno 20 mg al día",
			de: "Tamoxifen 20 mg täglich",
			fr: "tamoxifène 20 mg par jour",
			pt: "tamoxifeno 20 mg ao dia",
			vi: "tamoxifen 20 mg mỗi ngày",
		},
	},
	{
		code: "B20",
		text: {
			en: "Human immunodeficiency virus [HIV] disease",
			es: "Enfermedad por virus de la inmunodeficiencia humana [VIH]",
			de: "HIV-Krankheit",
			fr: "Maladie due au virus de l'immunodéficience humaine [VIH]",
			pt: "Doença pelo vírus da imunodeficiência humana [HIV]",
			vi: "Bệnh do virus gây suy giảm miễn dịch ở người [HIV]",
		},
		medication: {
			en: "bictegravir/emtricitabine/tenofovir alafenamide 1 tablet daily",
			es: "bictegravir/emtricitabina/tenofovir alafenamida 1 comprimido al día",
			de: "Bictegravir/Emtricitabin/Tenofoviralafenamid 1 Tablette täglich",
			fr: "bictégravir/emtricitabine/ténofovir alafénamide 1 comprimé par jour",
			pt: "bictegravir/entricitabina/tenofovir alafenamida 1 comprimido ao dia",
			vi: "bictegravir/emtricitabine/tenofovir alafenamide 1 viên mỗi ngày",
		},
	},
	{
		code: "N18.4",
		text: {
			en: "Chronic kidney disease, stage 4",
			es: "Enfermedad renal crónica, estadio 4",
			de: "Chronische Nierenkrankheit, Stadium 4",
			fr: "Maladie rénale chronique, stade 4",
			pt: "Doença renal crônica, estágio 4",
			vi: "Bệnh thận mạn giai đoạn 4",
		},
		medication: {
			en: "furosemide 40 mg daily",
			es: "furosemida 40 mg al día",
			de: "Furosemid 40 mg täglich",
			fr: "furosémide 40 mg par jour",
			pt: "furosemida 40 mg ao dia",
			vi: "furosemide 40 mg mỗi ngày",
		},
	},
	{
		code: "F10.20",
		text: {
			en: "Alcohol dependence, uncomplicated",
			es: "Dependencia del alcohol, sin complicaciones",
			de: "Alkoholabhängigkeit, unkompliziert",
			fr: "Dépendance à l'alcool, sans complication",
			pt: "Dependência de álcool, sem complicações",
			vi: "Nghiện rượu, không biến chứng",
		},
		medication: {
			en: "naltrexone 50 mg daily",
			es: "naltrexona 50 mg al día",
			de: "Naltrexon 50 mg täglich",
			fr: "naltrexone 50 mg par jour",
			pt: "naltrexona 50 mg ao dia",
			vi: "naltrexone 50 mg mỗi ngày",
		},
	},
	{
		code: "J45.40",
		text: {
			en: "Moderate persistent asthma, uncomplicated",
			es: "Asma persistente moderada, sin complicaciones",
			de: "Mittelgradiges persistierendes Asthma",
			fr: "Asthme persistant modéré",
			pt: "Asma persistente moderada, sem complicações",
			vi: "Hen phế quản dai dẳng mức độ vừa",
		},
		medication: {
			en: "budesonide/formoterol 160/4.5 mcg two puffs twice daily",
			es: "budesonida/formoterol 160/4,5 mcg dos inhalaciones dos veces al día",
			de: "Budesonid/Formoterol 160/4,5 µg zwei Hübe zweimal täglich",
			fr: "budésonide/formotérol 160/4,5 µg deux bouffées deux fois par jour",
			pt: "budesonida/formoterol 160/4,5 mcg duas inalações duas vezes ao dia",
			vi: "budesonide/formoterol 160/4,5 mcg hai nhát xịt ngày hai lần",
		},
	},
	{
		code: "G40.909",
		text: {
			en: "Epilepsy, unspecified, not intractable",
			es: "Epilepsia no especificada, no refractaria",
			de: "Epilepsie, nicht näher bezeichnet",
			fr: "Épilepsie, sans précision",
			pt: "Epilepsia não especificada, não refratária",
			vi: "Động kinh, không đặc hiệu",
		},
		medication: {
			en: "levetiracetam 500 mg twice daily",
			es: "levetiracetam 500 mg dos veces al día",
			de: "Levetiracetam 500 mg zweimal täglich",
			fr: "lévétiracétam 500 mg deux fois par jour",
			pt: "levetiracetam 500 mg duas vezes ao dia",
			vi: "levetiracetam 500 mg ngày hai lần",
		},
	},
	{
		code: "O24.410",
		text: {
			en: "Gestational diabetes mellitus in pregnancy, diet controlled",
			es: "Diabetes gestacional controlada con dieta",
			de: "Gestationsdiabetes, diätetisch eingestellt",
			fr: "Diabète gestationnel contrôlé par le régime",
			pt: "Diabetes gestacional controlada com dieta",
			vi: "Đái tháo đường thai kỳ, kiểm soát bằng chế độ ăn",
		},
		medication: {
			en: "prenatal vitamin 1 tablet daily",
			es: "vitamina prenatal 1 comprimido al día",
			de: "Pränatales Vitaminpräparat 1 Tablette täglich",
			fr: "vitamine prénatale 1 comprimé par jour",
			pt: "vitamina pré-natal 1 comprimido ao dia",
			vi: "vitamin tiền sản 1 viên mỗi ngày",
		},
	},
];
