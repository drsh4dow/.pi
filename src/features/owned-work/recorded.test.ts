import { expect, test } from "bun:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { firstRefAfter, unsettledRefs } from "./recorded.ts";

test("a session that names group-7 in its transcript starts this process's refs at 8", () => {
	const session = SessionManager.inMemory("/p");

	session.appendCustomEntry("owned-work", { type: "delegate-started", handle: "delegate-2" });
	session.appendCustomEntry("owned-work", { type: "group-started", handle: "group-7", members: ["delegate-2"] });
	session.appendCustomEntry("owned-work", { type: "job-settled", handle: "delegate-2" });
	session.appendCustomEntry("usage", { type: "delegate-started", handle: "delegate-40" });

	expect(firstRefAfter(session.getEntries())).toBe(8);
});

test("a session that never started work starts its refs at 1", () => {
	expect(firstRefAfter(SessionManager.inMemory("/p").getEntries())).toBe(1);
});

test("the work a transcript leaves unsettled is what it started and never settled", () => {
	const session = SessionManager.inMemory("/p");

	session.appendCustomEntry("owned-work", { type: "command-started", handle: "serve-1", kind: "serve" });
	session.appendCustomEntry("owned-work", { type: "delegate-started", handle: "delegate-2" });
	session.appendCustomEntry("owned-work", { type: "delegate-started", handle: "delegate-3" });
	session.appendCustomEntry("owned-work", { type: "job-settled", handle: "delegate-2" });
	session.appendCustomEntry("owned-work", { type: "group-started", handle: "group-4", members: ["delegate-3"] });

	expect(unsettledRefs(session.getEntries())).toEqual(["serve-1", "delegate-3", "group-4"]);
});
