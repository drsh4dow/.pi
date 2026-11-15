import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
	Judge,
	ScanResult,
	scan,
	Unscanned,
	type Cursor,
	type JudgeAnswer,
	type JudgeFailed,
	type JudgeInput,
	type Role,
	type Transcript,
} from "./index.ts";

const clean = Effect.succeed<JudgeAnswer>({ pPhi: 0, category: Option.none() });

export const scanWith = ({
	transcript,
	cursor = Unscanned.make({}),
	answer = () => clean,
	maxChars = 2_000_000,
}: {
	readonly transcript: Transcript;
	readonly cursor?: Cursor;
	readonly answer?: (input: JudgeInput) => Effect.Effect<JudgeAnswer, JudgeFailed>;
	readonly maxChars?: number;
}) => {
	const asked: Array<JudgeInput> = [];

	const ask = (input: JudgeInput) => {
		asked.push(input);

		return answer(input);
	};

	return Effect.map(Effect.provideService(scan(transcript, cursor), Judge, { maxChars, ask }), (result) => ({
		result,
		asked,
	}));
};

export const clearedCursor = (transcript: Transcript) =>
	Effect.map(scanWith({ transcript }), ({ result }) => {
		if (!ScanResult.$is("Clean")(result)) {
			throw new Error(`expected Clean, got ${result._tag}`);
		}

		return result.cursor;
	});

const said = (role: Role) => (text: string) => ({ role, parts: [{ kind: "text" as const, text }] });

export const system = said("system");

export const user = said("user");

export const assistant = said("assistant");

export const tool = said("tool");
