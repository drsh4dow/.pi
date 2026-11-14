import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";

export type PrState = "OPEN" | "MERGED" | "CLOSED";

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

/** One submitted review. PENDING (unsubmitted) reviews are dropped at the parse. */
export interface Review {
	readonly author: string;
	readonly state: string;
	readonly submittedAt: string;
}

/** The statusCheckRollup that gh reports, reduced to one bucket. */
export type Checks = "none" | "pending" | "pass" | "fail";

export interface PrView {
	/** `owner/repo#number`, from the pull request's `url`. */
	readonly ref: string;
	readonly head: string;
	readonly reviewDecision: Option.Option<ReviewDecision>;
	readonly reviews: ReadonlyArray<Review>;
	readonly checks: Checks;
	readonly state: PrState;
}

const CheckRun = Schema.Struct({
	__typename: Schema.Literal("CheckRun"),
	status: Schema.String,
	conclusion: Schema.String,
});

const StatusContext = Schema.Struct({ __typename: Schema.Literal("StatusContext"), state: Schema.String });

const WireReview = Schema.Struct({
	author: Schema.Struct({ login: Schema.String }),
	state: Schema.String,
	submittedAt: Schema.String,
});

const prUrl = /^https:\/\/[^/]+\/(?<repo>[^/]+\/[^/]+)\/pull\/(?<number>\d+)$/u;

const PrUrl = Schema.String.pipe(Schema.check(Schema.isPattern(prUrl)));

const Wire = Schema.Struct({
	url: PrUrl,
	headRefOid: Schema.String,
	reviewDecision: Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", ""]),
	reviews: Schema.Array(WireReview),
	statusCheckRollup: Schema.Array(Schema.Union([CheckRun, StatusContext])),
	state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
});

export const fields = Arr.join(Rec.keys(Wire.fields), ",");

type Check = (typeof Wire.Type)["statusCheckRollup"][number];

type Bucket = Exclude<Checks, "none">;

const failedRun = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

const failedContext = new Set(["FAILURE", "ERROR"]);

const pendingContext = new Set(["PENDING", "EXPECTED"]);

const runBucket = ({ status, conclusion }: typeof CheckRun.Type): Bucket => {
	if (failedRun.has(conclusion)) {
		return "fail";
	}

	return status === "COMPLETED" ? "pass" : "pending";
};

const contextBucket = ({ state }: typeof StatusContext.Type): Bucket => {
	if (failedContext.has(state)) {
		return "fail";
	}

	return pendingContext.has(state) ? "pending" : "pass";
};

const bucketOf = Match.type<Check>().pipe(
	Match.discriminatorsExhaustive("__typename")({ CheckRun: runBucket, StatusContext: contextBucket }),
);

const checksOf = (rollup: ReadonlyArray<Check>): Checks => {
	const buckets = Arr.map(rollup, bucketOf);

	if (Arr.isReadonlyArrayEmpty(buckets)) {
		return "none";
	}

	if (buckets.includes("fail")) {
		return "fail";
	}

	return buckets.includes("pending") ? "pending" : "pass";
};

const decodeWire = Schema.decodeUnknownResult(Schema.fromJsonString(Wire));

/** Reads the stdout of `gh pr view --json <fields>`, or says why it could not. */
export const viewOf = (stdout: string): Result.Result<PrView, string> =>
	decodeWire(stdout).pipe(
		Result.mapError((error) => error.message),
		Result.map((wire) => ({
			ref: Str.replace(prUrl, "$<repo>#$<number>")(wire.url),
			head: wire.headRefOid,
			reviewDecision: wire.reviewDecision === "" ? Option.none() : Option.some(wire.reviewDecision),
			reviews: Arr.flatMap(wire.reviews, ({ author, state, submittedAt }) =>
				state === "PENDING" ? [] : [{ author: author.login, state, submittedAt }],
			),
			checks: checksOf(wire.statusCheckRollup),
			state: wire.state,
		})),
	);
