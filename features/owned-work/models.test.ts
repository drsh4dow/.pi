import { expect, test } from "bun:test";

import * as Effect from "effect/Effect";
import * as Rec from "effect/Record";

import { modelTable } from "./models.ts";

const arena = Bun.file(new URL("../../agent/skills/arena/SKILL.md", import.meta.url));

test("the extra runner the arena names is a table alias outside the panel", () =>
	Effect.runPromise(
		Effect.map(
			Effect.promise(() => arena.text()),
			(text) => {
				const extra = /plus one on `(?<alias>[^`]+)`/u.exec(text)?.groups?.["alias"];

				expect(extra).toBe("divergent");
				expect(Rec.keys(modelTable.aliases)).toContain("divergent");
				expect(modelTable.panel).not.toContain("divergent");
			},
		),
	));
