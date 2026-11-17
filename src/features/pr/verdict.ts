import * as Effect from "effect/Effect";

import { Gh, GhError } from "#src/client/gh/index.ts";
import type { VerdictRecord } from "#src/client/verdicts/index.ts";

export type ReviewTarget = Pick<VerdictRecord, "repo" | "number" | "head" | "patchId">;

/** Reads the head again after the diff, so a push in between cannot pin one head with another's patch-id. */
export const pin = (pr: string) =>
	Effect.gen(function* () {
		const gh = yield* Gh;
		const { repo, number, head } = yield* gh.view(pr);
		const patchId = yield* gh.patchId(pr);
		const after = yield* gh.view(pr);

		if (after.head !== head) {
			const why = `its head moved from ${head} to ${after.head} while it was pinned, so start the verifier again`;

			return yield* GhError.make({ args: ["gh", "pr", "view", pr], why });
		}

		const target: ReviewTarget = { repo, number, head, patchId };

		return target;
	});
