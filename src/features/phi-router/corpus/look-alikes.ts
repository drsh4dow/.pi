import * as Arr from "effect/Array";
import * as Str from "effect/String";

import type { Sample } from "./conversation.ts";
import type { Random } from "./random.ts";
import { two, uuid } from "./record.ts";

const isoTime = (rng: Random) =>
	`2025-${two(rng.between(1, 12))}-${two(rng.between(1, 28))}T${two(rng.int(24))}:${two(rng.int(60))}:${two(rng.int(60))}Z`;

const semver = (rng: Random) =>
	`${String(rng.between(1, 9))}.${String(rng.between(0, 30))}.${String(rng.between(0, 20))}`;

const ciLog = (rng: Random): Sample => {
	const [month, day, hour] = [two(rng.between(1, 12)), two(rng.between(1, 28)), two(rng.int(24))];
	const build = `2025.${month}.${day}-${rng.digits(4)}`;
	const version = semver(rng);
	const at = (minute: number) => `2025-${month}-${day}T${hour}:${two(minute)}:${two(rng.int(60))}Z`;

	return {
		scene: {
			asks: [
				"The deploy step fails after the image push. What's wrong?",
				"Why did this pipeline tag the wrong version?",
			],
			commands: [`gh run view ${rng.digits(10)} --log-failed`],
			paths: ["ci-logs/deploy.log"],
		},
		payload: Arr.join(
			[
				`${at(1)} Build #${build} started for claims-api@${version}`,
				`${at(4)} Step 7/12 : COPY --from=builder /app/dist /srv`,
				`${at(7)} Successfully built ${rng.hex(12)}`,
				`${at(8)} Tagged registry.internal/claims-api:${version}-rc.${String(rng.between(1, 6))}+build.${rng.digits(8)}`,
				`${at(9)} digest: sha256:${rng.hex(64)} size: ${String(rng.between(1000, 9000))}`,
				`${at(19)} Error: deployment "claims-api" exceeded its progress deadline (ReplicaSet claims-api-${rng.hex(10)})`,
			],
			"\n",
		),
	};
};

const gitLog = (rng: Random): Sample => ({
	scene: {
		asks: ["Which of these commits broke the eligibility parser?", "Squash these into one release commit message."],
		commands: ["git log --format='%H %aI %s' -6"],
		paths: [".git/logs/HEAD"],
	},
	payload: Arr.join(
		Arr.map(
			[
				"fix(edi): accept 5010 trailers",
				"chore: bump deps",
				"feat(270): parse EB segments",
				"test: cover AAA rejects",
				"refactor: split mapper",
				"ci: cache bun",
			],
			(subject) => `${rng.hex(40)} ${isoTime(rng)} ${subject}`,
		),
		"\n",
	),
});

const packages = ["hl7v2", "node-x12", "zod", "pino", "fastify", "kysely", "date-fns"];

const lockfile = (rng: Random): Sample => {
	const entry = (name: string) => [
		`    "node_modules/${name}": {`,
		`      "version": "${semver(rng)}",`,
		`      "integrity": "sha512-${rng.chars("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", 86)}=="`,
		"    },",
	];

	const changed = Arr.take(rng.shuffle(packages), 4);

	return {
		scene: {
			asks: ["npm ci fails with an integrity error. Which package is it?", "Why did this lockfile change so much?"],
			commands: ["git diff HEAD~1 -- package-lock.json | head -40"],
			paths: ["package-lock.json"],
		},
		payload: Arr.join(Arr.flatMap(changed, entry), "\n"),
	};
};

const ndcCodes = (rng: Random): Sample => {
	const ndc = () => `${rng.digits(5)}-${rng.digits(3 + rng.int(2))}-${rng.digits(2)}`;

	return {
		scene: {
			asks: [
				"The formulary import rejects some NDCs. Is it the 4-4-2 vs 5-3-2 normalisation?",
				"Write a normaliser for these NDC formats to 11 digits.",
			],
			commands: ["head -8 data/formulary/ndc_import.csv"],
			paths: ["data/formulary/ndc_import.csv"],
		},
		payload: Arr.join(
			[
				"ndc,package_description,lot,expires",
				...Arr.makeBy(
					rng.between(4, 7),
					() =>
						`${ndc()},${String(rng.between(30, 500))} TABLET in 1 BOTTLE,${rng.chars("ABCDEFGHJKLMNPRSTUVWXYZ", 2)}${rng.digits(6)},2026-${two(rng.between(1, 12))}`,
				),
			],
			"\n",
		),
	};
};

const hl7Ack = (rng: Random): Sample => {
	const stamp = Str.replaceAll(/\D/gu, "")(isoTime(rng));

	return {
		scene: {
			asks: [
				"The sender keeps resending after our ACK. Is the ACK malformed?",
				"Why does the interface engine treat this ACK as an error?",
			],
			commands: ["tail -3 /var/log/mirth/outbound-acks.log"],
			paths: ["samples/acks/last.hl7"],
		},
		payload: Arr.join(
			[
				`MSH|^~\\&|INTEGRATION|ETL|EPICADT|NFH|${stamp}||ACK^A01^ACK|ACK${rng.digits(8)}|P|2.5.1`,
				`MSA|AA|MSG${rng.digits(8)}`,
			],
			"\r",
		),
	};
};

const x12Ack = (rng: Random): Sample => {
	const control = rng.digits(9);

	return {
		scene: {
			asks: ["Is this 999 an accept or a reject? The dashboard says pending.", "Parse this 999 into our ack table."],
			commands: ["cat inbound/999/latest.edi"],
			paths: ["inbound/999/latest.edi"],
		},
		payload: Arr.join(
			[
				`ISA*00*          *00*          *ZZ*CLEARSTREAM    *ZZ*NORTHFIELD     *25${two(rng.between(1, 12))}${two(rng.between(1, 28))}*${rng.digits(4)}*^*00501*${control}*0*P*:~`,
				`GS*FA*CLEARSTREAM*NORTHFIELD*2025${two(rng.between(1, 12))}${two(rng.between(1, 28))}*${rng.digits(4)}*${rng.digits(4)}*X*005010X231A1~`,
				`ST*999*0001*005010X231A1~`,
				`AK1*HC*${rng.digits(4)}*005010X222A1~`,
				`AK2*837*0001*005010X222A1~`,
				`IK5*A~`,
				`AK9*A*1*1*1~`,
				`SE*6*0001~`,
				`GE*1*${rng.digits(4)}~`,
				`IEA*1*${control}~`,
			],
			"\n",
		),
	};
};

const cloudEvents = (rng: Random): Sample => ({
	scene: {
		asks: [
			"Which request failed in this trace? The ids all look alike to me.",
			"Correlate these events by request id.",
		],
		commands: ["aws logs tail /ecs/claims-api --since 10m"],
		paths: ["logs/claims-api.jsonl"],
	},
	payload: Arr.join(
		Arr.makeBy(
			rng.between(3, 6),
			() =>
				`{"ts":"${isoTime(rng)}","level":"${rng.pick(["info", "warn", "error"])}","request_id":"${uuid(rng)}","account":"${rng.digits(12)}","build":"${semver(rng)}+${rng.hex(7)}","latency_ms":${String(rng.between(3, 2000))}}`,
		),
		"\n",
	),
});

export const lookAlikes: Arr.NonEmptyReadonlyArray<(rng: Random) => Sample> = [
	ciLog,
	gitLog,
	lockfile,
	ndcCodes,
	hl7Ack,
	x12Ack,
	cloudEvents,
];
