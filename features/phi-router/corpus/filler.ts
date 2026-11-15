import * as Arr from "effect/Array";
import * as Str from "effect/String";

import { diffHeader } from "./files.ts";
import type { Carrier } from "./manifest.ts";
import type { Random } from "./random.ts";
import { two } from "./record.ts";

type Words = Arr.NonEmptyReadonlyArray<string>;

const services: Words = [
	"api-gateway",
	"claims-worker",
	"auth",
	"scheduler",
	"notifier",
	"search-indexer",
	"remit-poller",
];

const routes: Words = [
	"/api/v2/claims",
	"/api/v2/claims/status",
	"/api/v2/eligibility",
	"/healthz",
	"/metrics",
	"/api/v2/remits",
];

const tables: Words = ["products", "feature_flags", "audit_events", "shipments", "inventory", "job_runs"];
const verbs: Words = ["load", "parse", "map", "sync", "fetch", "build", "merge", "resolve", "flush", "index", "retry"];
const nouns: Words = ["Batch", "Remit", "Payer", "Config", "Session", "Cursor", "Ledger", "Queue", "Token", "Report"];
const dirs: Words = ["billing", "claims", "eligibility", "shared", "api", "workers", "db", "util", "auth", "reports"];
const fields: Words = ["status", "createdAt", "batchId", "retries", "total", "cursor", "version", "region"];

const clock = (rng: Random) => {
	const day = `2025-${two(rng.between(1, 12))}-${two(rng.between(1, 28))}`;
	let millis = rng.between(0, 20_000_000);

	return () => {
		millis += rng.between(1, 900);

		const seconds = Math.floor(millis / 1000);

		return `${day}T${two(Math.floor(seconds / 3600) % 24)}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}.${Str.padStart(3, "0")(String(millis % 1000))}Z`;
	};
};

const logLine = (rng: Random, now: () => string) => {
	const service = rng.pick(services);
	const ms = String(rng.between(1, 2400));

	const messages = [
		() =>
			`INFO  ${service} ${rng.pick(["GET", "POST", "PUT"])} ${rng.pick(routes)} ${rng.pick(["200", "200", "201", "204", "404", "503"])} ${ms}ms req=${rng.hex(16)}`,
		() =>
			`DEBUG ${service} cache ${rng.pick(["hit", "miss"])} key=${Str.toLowerCase(rng.pick(nouns))}:${rng.hex(8)} ttl=${String(rng.between(30, 900))}s`,
		() =>
			`INFO  ${service} db pool active=${String(rng.int(40))} idle=${String(rng.int(20))} waiting=${String(rng.int(5))}`,
		() =>
			`WARN  ${service} slow query ${ms}ms: SELECT * FROM ${rng.pick(tables)} WHERE status = $1 LIMIT ${String(rng.between(10, 500))}`,
		() =>
			`INFO  ${service} kafka lag topic=${rng.pick(["remits.raw", "jobs.events", "audit.log"])} partition=${String(rng.int(12))} lag=${String(rng.int(5000))}`,
		() => `DEBUG ${service} gc pause=${String(rng.between(1, 80))}ms heap_used=${String(rng.between(200, 900))}MB`,
		() =>
			`INFO  scheduler job=${rng.pick(verbs)}-${Str.toLowerCase(rng.pick(nouns))} status=finished duration=${ms}ms`,
		() =>
			`DEBUG ${service} flag ${rng.pick(verbs)}_${Str.toLowerCase(rng.pick(nouns))}_v2=${rng.pick(["true", "false"])}`,
		() =>
			`WARN  ${service} retrying POST https://${rng.pick(services)}.internal/v1/${rng.pick(dirs)} attempt=${String(rng.between(1, 5))}`,
		() =>
			`INFO  ${service} span=${rng.hex(16)} parent=${rng.hex(16)} op=${rng.pick(verbs)}${rng.pick(nouns)} dur=${ms}ms`,
		() =>
			`INFO  ${service} tls handshake ok peer=${rng.pick(services)}.svc.cluster.local:${String(rng.between(8000, 9100))}`,
		() => `INFO  ${service} batch=${rng.digits(5)} rows=${String(rng.int(2000))} committed in ${ms}ms`,
	] as const;

	return `${now()} ${rng.pick(messages)()}`;
};

const sqlLine = (rng: Random) => {
	const rows = [
		() =>
			`INSERT INTO public.products VALUES (${rng.digits(6)}, 'SKU-${rng.digits(5)}', '${rng.pick(nouns)} ${rng.pick(["kit", "cable", "license", "adapter"])}', ${String(rng.between(1, 900))}.${rng.digits(2)});`,
		() =>
			`INSERT INTO public.feature_flags VALUES ('${rng.pick(verbs)}_${Str.toLowerCase(rng.pick(nouns))}', ${rng.pick(["true", "false"])}, ${String(rng.int(101))});`,
		() =>
			`INSERT INTO public.audit_events VALUES ('${rng.hex(8)}-${rng.hex(4)}-4${rng.hex(3)}-a${rng.hex(3)}-${rng.hex(12)}', '${rng.pick(verbs)}', '${rng.pick(services)}');`,
		() =>
			`INSERT INTO public.shipments VALUES (${rng.digits(7)}, '${rng.pick(["UPS", "FEDEX", "DHL"])}', '1Z${rng.chars("ABCDEFGHJKLMNPRSTUVWXYZ0123456789", 16)}', '${rng.pick(["in_transit", "delivered", "label_created"])}');`,
		() =>
			`INSERT INTO public.inventory VALUES ('SKU-${rng.digits(5)}', '${rng.pick(["pdx-1", "iad-2", "fra-1"])}', ${String(rng.int(4000))});`,
	] as const;

	return rng.pick(rows)();
};

const csvLine = (rng: Random) =>
	`2025-${two(rng.between(1, 12))}-${two(rng.between(1, 28))},${rng.pick(["us-west", "us-east", "eu-central"])},SKU-${rng.digits(5)},${String(rng.int(400))},${String(rng.between(1, 300))}.${rng.digits(2)},${rng.pick(["web", "partner", "retail"])}`;

const functionLines = (rng: Random) => {
	const [verb, noun, field, other] = [rng.pick(verbs), rng.pick(nouns), rng.pick(fields), rng.pick(fields)];
	const local = Str.toLowerCase(noun);

	return [
		`export async function ${verb}${noun}(input: ${rng.pick(nouns)}Input): Promise<${noun}> {`,
		`\tconst ${local} = await client.${rng.pick(verbs)}${noun}(input.${field});`,
		`\tif (${local}.${other} === undefined) {`,
		`\t\tthrow new ${noun}Error("missing ${other}", { ${field}: input.${field} });`,
		"\t}",
		`\tlogger.debug("${verb} ${local}", { ${field}: input.${field}, ms: Date.now() - started });`,
		`\treturn { ...${local}, ${other}: ${local}.${other} ?? ${String(rng.int(100))} };`,
		"}",
	];
};

const diffBlock = (rng: Random) => {
	const path = `src/${rng.pick(dirs)}/${Str.toLowerCase(rng.pick(nouns))}.ts`;
	const start = rng.between(1, 400);
	const body = functionLines(rng);
	const changed = rng.between(1, 5);
	const field = rng.pick(fields);
	const added = [`\tif (input.${field} === null) return undefined;`, functionLines(rng)[changed] ?? ""];

	return Arr.join(
		[
			...diffHeader({ rng, path }),
			`@@ -${String(start)},${String(body.length)} +${String(start)},${String(body.length + 1)} @@`,
			...Arr.map(Arr.take(body, changed), (line) => ` ${line}`),
			`-${body[changed] ?? ""}`,
			...Arr.map(added, (line) => `+${line}`),
			...Arr.map(Arr.drop(body, changed + 1), (line) => ` ${line}`),
		],
		"\n",
	);
};

const pathLine = (rng: Random) =>
	rng.pick([
		() => `./src/${rng.pick(dirs)}/${rng.pick(dirs)}/${rng.pick(verbs)}-${Str.toLowerCase(rng.pick(nouns))}.ts`,
		() => `./node_modules/@${rng.pick(dirs)}/${Str.toLowerCase(rng.pick(nouns))}/dist/${rng.pick(verbs)}.js`,
		() => `./test/${rng.pick(dirs)}/${rng.pick(verbs)}-${Str.toLowerCase(rng.pick(nouns))}.test.ts`,
		() => `./exports/archive/2025-${two(rng.between(1, 12))}/batch_${rng.digits(4)}.csv`,
	] as const)();

const lineSources: Partial<Record<typeof Carrier.Type, (rng: Random) => string>> = {
	"sql-dump": sqlLine,
	csv: csvLine,
	"git-diff": diffBlock,
	"file-name": pathLine,
};

const lineSource = (carrier: typeof Carrier.Type, rng: Random) => {
	const source = lineSources[carrier];

	if (source !== undefined) {
		return source;
	}

	const now = clock(rng);

	return (draw: Random) => logLine(draw, now);
};

const fill = (drawLine: (rng: Random) => string, rng: Random, size: number) => {
	const lines: Array<string> = [];
	let length = 0;

	while (length < size) {
		const line = drawLine(rng);

		lines.push(line);
		length += line.length + 1;
	}

	return Arr.join(lines, "\n");
};

interface BuryRequest {
	readonly rng: Random;
	readonly carrier: typeof Carrier.Type;
	readonly size: number;
}

export const bury =
	({ rng, carrier, size }: BuryRequest) =>
	(payload: string) => {
		const drawLine = lineSource(carrier, rng);
		const before = Math.floor(size * (0.35 + rng.int(30) / 100));

		return `${fill(drawLine, rng, before)}\n${payload}\n${fill(drawLine, rng, size - before)}`;
	};
