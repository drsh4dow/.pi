import * as Arr from "effect/Array";

import type { Sample, Scene } from "./conversation.ts";
import { drawName } from "./people.ts";
import type { Random } from "./random.ts";
import { systemTime, two } from "./record.ts";

const patientId = (rng: Random) => String(rng.between(1000, 99_999));

const identityScene: Scene = {
	asks: [
		"Identity verification fails for some callers. What do these logs show?",
		"Why does the verify step reject this one?",
	],
	commands: ["kubectl logs deploy/identity-verify --since=15m | tail -n 3"],
	paths: ["logs/identity-verify.log"],
};

const logged = (rng: Random, line: string) =>
	Arr.join(
		[
			`${systemTime(rng)} INFO  verify session=${rng.hex(12)} started`,
			`${systemTime(rng)} WARN  ${line}`,
			`${systemTime(rng)} INFO  verify session closed`,
		],
		"\n",
	);

const maskedSsn = (rng: Random): Sample => {
	const masked = `***-**-${rng.digits(4)}`;

	return {
		scene: identityScene,
		payload: logged(rng, `verify patient_id=${patientId(rng)} ssn=${masked} method=kba result=mismatch`),
		fragments: [masked],
	};
};

const ssnPrefix = (rng: Random): Sample => {
	const prefix = `${String(rng.between(900, 999))}-${two(rng.between(1, 99))}`;

	return {
		scene: identityScene,
		payload: logged(
			rng,
			`verify patient_id=${patientId(rng)} rejected: ssn prefix "${prefix}" is outside the issued range`,
		),
		fragments: [prefix],
	};
};

const birthDateAlone = (rng: Random): Sample => {
	const birthDate = `${String(rng.between(1934, 2006))}-${two(rng.between(1, 12))}-${two(rng.between(1, 28))}`;

	return {
		scene: {
			asks: ["Eligibility comes back inactive for this one. Is the date format the problem?"],
			commands: ["grep patient_id logs/eligibility.log | tail -n 1"],
			paths: ["logs/eligibility.log"],
		},
		payload: `${systemTime(rng)} eligibility patient_id=${patientId(rng)} dob=${birthDate} plan=CMHP01 result=inactive`,
		fragments: [birthDate],
	};
};

/** A given name of six letters or more, so it is long enough to track. */
const givenName = (rng: Random): string => {
	const { given } = drawName("en")(rng);

	return given.length >= 6 ? given : givenName(rng);
};

const firstNameOnly = (rng: Random): Sample => {
	const given = givenName(rng);

	return {
		scene: {
			asks: ["Can you link this voicemail ticket to the right record in our tracker?"],
			commands: ["zd ticket show --latest --queue callbacks"],
			paths: ["support/tickets/callback-latest.txt"],
		},
		payload: Arr.join(
			[
				`Ticket #${rng.digits(5)} (callbacks)`,
				`Voicemail from ${given}, first name only, asking about a claim status.`,
				`Internal ref: patient_id ${patientId(rng)}`,
			],
			"\n",
		),
		fragments: [given],
	};
};

const memberPrefix = (rng: Random): Sample => {
	const prefix = `${rng.chars("ABCDEFGHJKLMNPRSTUVWXYZ", 3)}${rng.digits(3)}`;

	return {
		scene: {
			asks: ["The masking helper leaves the first six characters. Is that what this log shows?"],
			commands: ["grep member_id logs/claims-worker.log | tail -n 1"],
			paths: ["logs/claims-worker.log"],
		},
		payload: `${systemTime(rng)} claim accepted patient_id=${patientId(rng)} member_id=${prefix}****** payer=60054`,
		fragments: [prefix],
	};
};

const streetOnly = (rng: Random): Sample => {
	const street = `${drawName("en")(rng).family} ${rng.pick(["Ave", "Street", "Road", "Lane"])}`;

	return {
		scene: {
			asks: ["The geocoder misses a lot of addresses. Is it the street suffix?"],
			commands: ["grep 'geocode miss' logs/geocoder.log | tail -n 1"],
			paths: ["logs/geocoder.log"],
		},
		payload: `${systemTime(rng)} geocode miss patient_id=${patientId(rng)} street="${street}" zip3=${rng.digits(3)}`,
		fragments: [street],
	};
};

/** Partial identifiers: a masked or half SSN, a birth date without a name, a first name, an id prefix, a street name. */
export const fragmentSamples: Arr.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	maskedSsn,
	ssnPrefix,
	birthDateAlone,
	firstNameOnly,
	memberPrefix,
	streetOnly,
];
