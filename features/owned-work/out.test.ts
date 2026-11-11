import { expect, test } from "bun:test";

import * as Option from "effect/Option";

import { Out } from "./out.ts";
import { FailReason, Outcome, WorkRef } from "./work.ts";

const ref = WorkRef("watch-3");

const log = Option.some("/s/delegates/w.log");

test("a fired watch wakes the agent with its exit code, log path and last lines", () => {
	const outcome = Outcome.Fired({ exitCode: 143, tail: "line 200" });

	expect(Out.result({ ref, kind: "watch", outcome, log })).toEqual({
		ref,
		kind: "watch",
		outcome: { status: "fired", exit_code: 143, log: "/s/delegates/w.log", tail: "line 200" },
	});
});

test("a cancelled watch wakes the agent with its log path", () => {
	const outcome = Outcome.Failed({ reason: FailReason.Cancelled({ group: Option.none() }) });

	expect(Out.result({ ref, kind: "watch", outcome, log })).toEqual({
		ref,
		kind: "watch",
		outcome: {
			status: "failed",
			reason: "cancelled",
			detail: "cancelled by your cancel call",
			log: "/s/delegates/w.log",
		},
	});
});
