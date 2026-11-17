import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export interface SpendRequest {
	/** The folder that holds every session, such as `~/.pi/agent/sessions`. Delegates' sessions sit inside it. */
	readonly root: string;
	readonly provider: string;
	readonly since: DateTime.Utc;
}

/** What pi priced one provider's replies at, from the models' list prices, not from the provider's bill. */
export interface Spend {
	readonly usd: number;
	readonly replies: number;
}

export class SessionsUnreadable extends Schema.TaggedError<SessionsUnreadable, { readonly brand: unique symbol }>()(
	"SessionsUnreadable",
	{
		path: Schema.String,
		why: Schema.String,
	},
) {}

const Usage = Schema.Struct({ cost: Schema.Struct({ total: Schema.Finite }) });

/** Only the fields `spend` reads from a session line. */
const PricedReply = Schema.Struct({
	type: Schema.Literal("message"),
	message: Schema.Struct({
		role: Schema.Literal("assistant"),
		provider: Schema.String,
		timestamp: Schema.Finite,
		usage: Usage,
	}),
});

const decodeReply = Schema.decodeOption(Schema.fromJsonString(PricedReply));

const unreadable = (path: string) => (cause: unknown) => SessionsUnreadable.make({ path, why: String(cause) });

const isOnOrAfter = (since: DateTime.Utc) => (mtime: Option.Option<Date>) =>
	Option.exists(mtime, (modified) => modified.getTime() >= DateTime.toEpochMillis(since));

/** The session files written to since `since`, since a file untouched before then holds no reply after it. */
const sessionFiles = ({ root, since }: SpendRequest) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const names = yield* Effect.mapError(fs.readDirectory(root, { recursive: true }), unreadable(root));
		const files = Arr.map(Arr.filter(names, Str.endsWith(".jsonl")), (name) => `${root}/${name}`);
		const touched = isOnOrAfter(since);

		return yield* Effect.filter(files, (file) =>
			Effect.mapBoth(fs.stat(file), { onFailure: unreadable(file), onSuccess: ({ mtime }) => touched(mtime) }),
		);
	});

/** Session files run to gigabytes, so a line is parsed only when it names the provider. */
const costOf =
	({ provider, since }: SpendRequest) =>
	(line: string): Option.Option<number> => {
		const priced = Str.includes(`"provider":"${provider}"`)(line) ? decodeReply(line) : Option.none();

		const counted = Option.filter(
			priced,
			({ message }) => message.provider === provider && message.timestamp >= DateTime.toEpochMillis(since),
		);

		return Option.map(counted, ({ message }) => message.usage.cost.total);
	};

const spendIn = (text: string, request: SpendRequest): Spend => {
	const costs = Arr.getSomes(Arr.map(Str.split("\n")(text), costOf(request)));

	return { usd: Arr.reduce(costs, 0, (sum, cost) => sum + cost), replies: costs.length };
};

const total = (spends: ReadonlyArray<Spend>): Spend => ({
	usd: Arr.reduce(spends, 0, (sum, { usd }) => sum + usd),
	replies: Arr.reduce(spends, 0, (sum, { replies }) => sum + replies),
});

/** What pi priced one provider's replies at since a time, across every session under `root`. */
export const spendSince = (request: SpendRequest) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const files = yield* sessionFiles(request);

		const read = (file: string) =>
			Effect.mapBoth(fs.readFileString(file), {
				onFailure: unreadable(file),
				onSuccess: (text) => spendIn(text, request),
			});

		// A few files at a time, so the gigabytes never sit in memory at once.
		const spends = yield* Effect.forEach(files, read, { concurrency: 8 });

		return total(spends);
	});
