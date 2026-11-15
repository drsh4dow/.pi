import type { Scene } from "./conversation.ts";
import { clinicalNote, screenshotText, ticket } from "./documents.ts";
import { fhirJson } from "./fhir.ts";
import { fileName, gitDiff } from "./files.ts";
import { hl7v2 } from "./hl7.ts";
import { logLine, stackTrace } from "./logs.ts";
import type { Carrier } from "./manifest.ts";
import type { RenderInput } from "./record.ts";
import { csv, sqlDump } from "./tabular.ts";
import { x12837 } from "./x12.ts";

interface CarrierSpec extends Scene {
	readonly render: (input: RenderInput) => string;
	readonly mimeType: string;
}

export const carriers = {
	"sql-dump": {
		render: sqlDump,
		asks: [
			"The nightly warehouse load rejects one row from this table and I can't see why. Can you find the bad value?",
			"Restoring this dump into staging fails partway through. What's wrong with it?",
			"Migration 0042 changed this table and now the import breaks on this row.",
		],
		commands: [
			"pg_dump --data-only --table=public.member_claims claims_prod | tail -n 20",
			"mysqldump claims --where=\"status='failed'\"",
		],
		paths: ["backups/staging/failed_row.sql", "tmp/restore/claims_dump.sql"],
		mimeType: "application/sql",
	},
	csv: {
		render: csv,
		asks: [
			"The billing export CSV has the wrong column count on some rows. Can you check this one?",
			"Our importer chokes on this CSV row. Why?",
			"Excel opens this export fine but the parser rejects it. Can you look?",
		],
		commands: [
			"head -n 2 exports/billing_export.csv",
			"aws s3 cp s3://nfh-exports/daily/billing_export.csv - | head -n 2",
		],
		paths: ["exports/billing_export.csv", "fixtures/import/failing_row.csv"],
		mimeType: "text/csv",
	},
	"fhir-json": {
		render: fhirJson,
		asks: [
			"This bundle fails validation against US Core on the server. What's missing?",
			"The FHIR import job returns 422 for this bundle. Can you see why?",
			"Our mapper produces this bundle and the downstream EHR rejects it. Can you check the structure?",
		],
		commands: [
			"curl -s https://fhir.northfield-health.example/r4/Bundle/$BUNDLE_ID",
			"jq . out/bundles/failed/latest.json",
		],
		paths: ["out/bundles/failed/latest.json", "test/data/bundle_rejected.json"],
		mimeType: "application/fhir+json",
	},
	hl7v2: {
		render: hl7v2,
		asks: [
			"Why does our HL7 parser throw on this message?",
			"The interface engine routes this message to the error queue. Can you spot the problem?",
			"Segment parsing fails on this message after the library upgrade. What changed?",
		],
		commands: ["mllp-cat --last 1 adt_inbound", "tail -n 12 /var/log/interface/adt_error_queue.hl7"],
		paths: ["samples/adt/failing.hl7", "var/error_queue/msg_latest.hl7"],
		mimeType: "x-application/hl7-v2+er7",
	},
	"x12-837": {
		render: x12837,
		asks: [
			"The clearinghouse rejected this 837 with a 999 error. Which segment is wrong?",
			"Our 837 generator output fails the SNIP level 2 check. Can you look?",
			"The payer says the claim is malformed. Here's what we sent.",
		],
		commands: ["cat out/edi/837P_latest.edi", "aws s3 cp s3://nfh-edi/outbound/837P_latest.edi -"],
		paths: ["out/edi/837P_latest.edi", "test/edi/rejected_claim.edi"],
		mimeType: "application/EDI-X12",
	},
	"log-line": {
		render: logLine,
		asks: [
			"The claims worker keeps failing one batch. What's going on in these logs?",
			"Why does this batch get retried and then partly fail?",
			"Can you tell from the logs why one record is rejected?",
		],
		commands: [
			"kubectl logs deploy/claims-worker --since=10m | tail -n 4",
			"journalctl -u etl-loader -n 4 --no-pager",
		],
		paths: ["logs/claims-worker.log", "var/log/etl/loader.log"],
		mimeType: "text/plain",
	},
	"stack-trace": {
		render: stackTrace,
		asks: [
			"The mapper crashes with this exception. Where should I look?",
			"This exception started after yesterday's deploy. Can you explain it?",
			"Our job dies with this trace. Is it the data or the code?",
		],
		commands: [
			"./gradlew :etl:test --tests ClaimMapperTest 2>&1 | tail -n 8",
			"python -m etl.run --batch latest 2>&1 | tail -n 8",
		],
		paths: ["logs/crash/latest.txt", "tmp/trace.txt"],
		mimeType: "text/plain",
	},
	"clinical-note": {
		render: clinicalNote,
		asks: [
			"Our section splitter misses the assessment in this note. Can you see why?",
			"The NLP pipeline extracts no diagnosis from this note. What's different about it?",
			"The note renderer drops the plan section for this one. Can you check?",
		],
		commands: [
			"psql -At -c \"select body from notes where status = 'failed' limit 1\"",
			"aws s3 cp s3://nfh-notes/failed/latest.txt -",
		],
		paths: ["test/notes/failing_note.txt", "data/notes/sample_latest.txt"],
		mimeType: "text/plain",
	},
	ticket: {
		render: ticket,
		asks: [
			"Support escalated this ticket. Can you figure out which part of the export is wrong?",
			"Can you reproduce the bug in this ticket?",
			"Here's the ticket from the front desk. Where would this break in our code?",
		],
		commands: ["zd ticket show --latest --queue billing", "gh issue view 812 --repo northfield/claims-support"],
		paths: ["support/tickets/latest.txt", "docs/escalations/latest.md"],
		mimeType: "text/plain",
	},
	"git-diff": {
		render: gitDiff,
		asks: [
			"Can you review this diff before I push?",
			"CI fails on this change. What did I break?",
			"Is this fixture change safe to merge?",
		],
		commands: ["git diff HEAD~1 -- test db", "git show --patch HEAD -- test db"],
		paths: ["patches/fixture-update.diff", "tmp/review.patch"],
		mimeType: "text/x-diff",
	},
	"file-name": {
		render: fileName,
		asks: [
			"The archive job skips some files in this folder. Which ones and why?",
			"Can you write a cleanup script for this export folder? Here's what's in it.",
			"The SFTP upload fails on one of these files. Any idea which?",
		],
		commands: ["find exports -type f | sort", "ls -1R exports"],
		paths: ["exports/INDEX.txt", "tmp/export_listing.txt"],
		mimeType: "text/plain",
	},
	screenshot: {
		render: screenshotText,
		asks: [
			"The claims grid renders this row wrong. Screenshot attached.",
			"Why does the denial column show this? See the screenshot.",
			"The UI cuts off this row. Here's what the support agent sees.",
		],
		commands: ["playwright screenshot http://localhost:3000/claims/denials shot.png && tesseract shot.png -"],
		paths: ["screenshots/claims-denials.png"],
		mimeType: "text/plain",
	},
} satisfies Record<typeof Carrier.Type, CarrierSpec>;
