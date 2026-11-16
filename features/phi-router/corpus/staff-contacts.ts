import * as Arr from "effect/Array";
import * as Str from "effect/String";

import type { Sample } from "./conversation.ts";
import { drawName, fullName, slug } from "./people.ts";
import type { Random } from "./random.ts";

interface Contact {
	readonly name: string;
	readonly email: string;
	/** A business line in the 555-01xx range, which is reserved for fiction. */
	readonly phone: string;
}

const contact = (rng: Random, domain: string): Contact => {
	const name = fullName(drawName("en")(rng));

	return { name, email: `${slug(".")(name)}@${domain}`, phone: `(503) 555-01${rng.digits(2)}` };
};

const staff = "northfield-health.example";

const onCall = (rng: Random): Sample => {
	const [primary, secondary] = [contact(rng, staff), contact(rng, staff)];

	return {
		scene: {
			asks: [
				"Add a third engineer to this rotation and fix the indentation.",
				"Why does PagerDuty reject this rota file?",
			],
			commands: ["cat ops/oncall/claims-platform.yml"],
			paths: ["ops/oncall/claims-platform.yml"],
		},
		payload: Arr.join(
			[
				"rotation: claims-platform",
				"handoff: monday 09:00 America/Los_Angeles",
				"primary:",
				`  name: ${primary.name}`,
				`  email: ${primary.email}`,
				`  phone: "${primary.phone}"`,
				"secondary:",
				`  name: ${secondary.name}`,
				`  email: ${secondary.email}`,
				`  phone: "${secondary.phone}"`,
				"escalation_minutes: 15",
			],
			"\n",
		),
	};
};

const vendorEmail = (rng: Random): Sample => {
	const vendor = contact(rng, "clearstream-edi.example");
	const engineer = contact(rng, staff);
	const batch = rng.digits(4);

	return {
		scene: {
			asks: [
				"The clearinghouse sent this about our rejects. What do they want us to change?",
				"Draft a reply to this vendor email.",
			],
			commands: ["cat support/vendor/clearstream-latest.eml"],
			paths: ["support/vendor/clearstream-latest.eml"],
		},
		payload: Arr.join(
			[
				`From: ${vendor.name} <${vendor.email}>`,
				`To: ${engineer.name} <${engineer.email}>`,
				`Subject: Re: 999 rejects on batch ${batch}`,
				"",
				`Hi ${Str.split(" ")(engineer.name)[0] ?? "there"},`,
				"",
				`Batch ${batch} failed SNIP level 2 again: the GS08 version is 005010X222 without the A1 suffix.`,
				"Once you regenerate it, resubmit and I'll watch the queue.",
				"",
				"Regards,",
				vendor.name,
				"Integration Engineer, Clearstream EDI",
				`Direct: ${vendor.phone}`,
			],
			"\n",
		),
	};
};

const contacts = (rng: Random): Sample => {
	const rows = Arr.makeBy(rng.between(3, 5), () => {
		const person = contact(rng, staff);

		const role = rng.pick([
			"Billing lead",
			"Integration engineer",
			"Clinic manager",
			"Data steward",
			"Front desk lead",
		]);

		return `| ${person.name} | ${role} | ${person.email} | ${person.phone} |`;
	});

	return {
		scene: {
			asks: ["Turn this contact table into a CODEOWNERS file.", "Sort this escalation list by role."],
			commands: ["cat docs/CONTACTS.md"],
			paths: ["docs/CONTACTS.md"],
		},
		payload: Arr.join(["| Name | Role | Email | Phone |", "| --- | --- | --- | --- |", ...rows], "\n"),
	};
};

const gitAuthors = (rng: Random): Sample => ({
	scene: {
		asks: ["Who should review changes to the mapper, going by this?", "Dedupe these authors for the changelog."],
		commands: ["git shortlog -sne -- src/mapper"],
		paths: [".mailmap"],
	},
	payload: Arr.join(
		Arr.makeBy(rng.between(3, 6), () => {
			const person = contact(rng, staff);

			return `${Str.padStart(6)(String(rng.between(2, 180)))}\t${person.name} <${person.email}>`;
		}),
		"\n",
	),
});

const submitter = (rng: Random): Sample => {
	const desk = contact(rng, staff);
	const control = rng.digits(9);

	return {
		scene: {
			asks: ["The payer bounces this 837 header. Is the submitter loop right?"],
			commands: ["head -n 6 out/edi/837P_latest.edi"],
			paths: ["out/edi/837P_latest.edi"],
		},
		payload: Arr.join(
			[
				`ISA*00*          *00*          *ZZ*NORTHFIELD     *ZZ*CLEARSTREAM    *250304*0215*^*00501*${control}*0*P*:~`,
				"GS*HC*NORTHFIELD*CLEARSTREAM*20250304*0215*1*X*005010X222A1~",
				"ST*837*0001*005010X222A1~",
				`NM1*41*2*NORTHFIELD BILLING*****46*S${rng.digits(5)}~`,
				`PER*IC*${Str.toUpperCase(desk.name)}*TE*${Str.replaceAll(/\D/gu, "")(desk.phone)}*EM*${desk.email}~`,
				"NM1*40*2*CLEARSTREAM EDI*****46*CSE0042~",
			],
			"\n",
		),
	};
};

/** Staff, vendor and business contacts: names, work emails and business phones of people who are not patients. */
export const staffContacts: Arr.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	onCall,
	vendorEmail,
	contacts,
	gitAuthors,
	submitter,
];
