import { expect, test } from "bun:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { ContentKey, Finding, Verdict } from "./policy/engine.ts";
import { policyVersion } from "./policy/policy.ts";
import { bookOf, type VerdictBook, verdictsEntryType } from "./store.ts";

const key = (name: string) => ContentKey.make(name);

const inHome = <Value, Failure>(body: (home: string) => Effect.Effect<Value, Failure, FileSystem.FileSystem>) => {
	const run = Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const home = yield* fs.makeTempDirectory();
		const config = ConfigProvider.fromEnvRecord({ HOME: home });

		return yield* Effect.provideService(body(home), ConfigProvider.ConfigProvider, config);
	});

	return Effect.runPromise(Effect.provide(run, NodeServices.layer));
};

const verdicts = (...stored: ReadonlyArray<readonly [string, "c" | "s", string]>) => ({
	policy: policyVersion,
	verdicts: stored,
});

const seals = (book: VerdictBook, names: ReadonlyArray<string>) => Arr.map(names, (name) => book.lookup(key(name)));

test("the book folds the verdict entries of every branch, not only the current one", () =>
	inHome(() =>
		Effect.gen(function* () {
			const session = SessionManager.inMemory("/work");
			const root = session.appendCustomEntry(verdictsEntryType, verdicts(["root", "c", "judge"]));

			session.appendCustomEntry(verdictsEntryType, verdicts(["abandoned", "s", "ssn"]));
			session.branch(root);
			session.appendCustomEntry(verdictsEntryType, verdicts(["current", "c", "rules-only"]));

			const book = yield* bookOf({ sessionManager: session, pid: 1 });

			expect(seals(book, ["root", "abandoned", "current", "never"])).toEqual([
				"cleared",
				"sealed",
				"cleared",
				undefined,
			]);
			expect(book.known(key("abandoned"))).toBe(true);
			expect(book.known(key("never"))).toBe(false);
		}),
	));

test("sealed beats cleared for one key in either order", () =>
	inHome(() =>
		Effect.gen(function* () {
			const session = SessionManager.inMemory("/work");

			session.appendCustomEntry(verdictsEntryType, verdicts(["first-cleared", "c", "judge"]));
			session.appendCustomEntry(verdictsEntryType, verdicts(["first-cleared", "s", "patient-name"]));
			session.appendCustomEntry(verdictsEntryType, verdicts(["first-sealed", "s", "judge-error"]));
			session.appendCustomEntry(verdictsEntryType, verdicts(["first-sealed", "c", "judge"]));

			const book = yield* bookOf({ sessionManager: session, pid: 1 });

			expect(seals(book, ["first-cleared", "first-sealed"])).toEqual(["sealed", "sealed"]);
		}),
	));

test("an entry of another policy version or a malformed entry is ignored, and later entries still count", () =>
	inHome(() =>
		Effect.gen(function* () {
			const session = SessionManager.inMemory("/work");

			session.appendCustomEntry(verdictsEntryType, { policy: "an-older-policy", verdicts: [["old", "s", "ssn"]] });
			session.appendCustomEntry(verdictsEntryType, { policy: policyVersion, verdicts: [["torn", "x", "ssn"]] });
			session.appendCustomEntry(verdictsEntryType, "not an object");
			session.appendCustomEntry(verdictsEntryType, verdicts(["later", "c", "judge"]));

			const book = yield* bookOf({ sessionManager: session, pid: 1 });

			expect(seals(book, ["old", "torn", "later"])).toEqual([undefined, undefined, "cleared"]);
		}),
	));

test("a system verdict goes to this process's cache file, which another process's book reads", () =>
	inHome((home) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const folder = `${home}/.local/state/pi-phi-router/system/${policyVersion}`;
			const book = yield* bookOf({ sessionManager: SessionManager.inMemory("/work"), pid: 101 });

			const entry = yield* book.record({
				found: [
					[key("prompt"), Verdict.Cleared({ by: "judge" })],
					[key("section"), Verdict.Sealed({ finding: Finding.Judge({ score: 0.9, kind: "patient-name" }) })],
					[key("flaky"), Verdict.Sealed({ finding: Finding.Failure({ why: "judge-timeout" }) })],
					[key("paste"), Verdict.Sealed({ finding: Finding.Rule({ rule: "ssn", kind: "ssn" }) })],
				],
				pieces: [
					{ key: key("prompt"), kind: "system" },
					{ key: key("section"), kind: "system" },
					{ key: key("flaky"), kind: "system" },
					{ key: key("paste"), kind: "user" },
				],
			});

			expect(entry).toEqual(Option.some({ policy: policyVersion, verdicts: [[key("paste"), "s", "ssn"]] }));
			expect(seals(book, ["prompt", "section", "flaky", "paste"])).toEqual([
				"cleared",
				"sealed",
				"sealed",
				"sealed",
			]);

			yield* fs.writeFileString(`${folder}/102.jsonl`, '\n["section","c","judge"]\n["cut-short","s"');

			const other = yield* bookOf({ sessionManager: SessionManager.inMemory("/work"), pid: 103 });

			expect(seals(other, ["prompt", "section", "flaky", "paste", "cut-short"])).toEqual([
				"cleared",
				"sealed",
				undefined,
				undefined,
				undefined,
			]);
		}),
	));
