import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import { type GuideFile, guidesOf, indexOf, inContext } from "../loaded/index.ts";

export const guideBudget = 120_000;

export interface Guides {
	readonly restored: ReadonlyArray<{ readonly path: string; readonly text: string }>;
	readonly listed: ReadonlyArray<string>;
}

export const noGuides: Guides = { restored: [], listed: [] };

interface Before {
	readonly files: ReadonlyArray<GuideFile & { readonly text: string }>;
	readonly branch: ReadonlyArray<SessionEntry>;
	readonly firstKeptEntryId: string;
}

const lostGuides = ({ files, branch, firstKeptEntryId }: Before) => {
	const index = indexOf(guidesOf(files));
	const { entries } = buildSessionProjection([...branch]);
	const kept = Arr.dropWhile(entries, (entry) => entry.sourceEntry.id !== firstKeptEntryId);
	const stays = new Set(Arr.map(inContext({ index, entries: kept }), ({ path }) => path));

	const byPath = new Map(Arr.map(files, (file) => [file.path, file]));
	const lost = Arr.filter(inContext({ index, entries }), ({ path }) => !stays.has(path));

	return Arr.flatMap(lost, ({ path }) => Option.toArray(Option.fromNullishOr(byPath.get(path))));
};

/** The lost guides restore as their files read now, until one passes the budget. That one and the rest are listed. */
export const guidesToRestore = (before: Before): Guides => {
	const lost = lostGuides(before);
	const totals = Arr.scan(lost, 0, (sum, { text }) => sum + text.length).slice(1);
	const pastBudget = Arr.findFirstIndex(totals, (total) => total > guideBudget);
	const fits = Option.getOrElse(pastBudget, () => lost.length);

	return {
		restored: Arr.take(lost, fits),
		listed: Arr.map(Arr.drop(lost, fits), ({ path }) => path),
	};
};
