import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import {
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ReadonlyFooterDataProvider,
	type SessionEntry,
	SettingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Str from "effect/String";

export interface FooterContext {
	readonly sessionManager: Pick<
		ExtensionContext["sessionManager"],
		"getCwd" | "getEntries" | "getLeafId" | "getSessionId" | "getSessionName"
	>;
	readonly model: Model<Api> | undefined;
	readonly modelRegistry: Pick<ExtensionContext["modelRegistry"], "isUsingOAuth">;
	readonly getContextUsage: () => ContextUsage | undefined;
}

export interface FooterInputs {
	readonly ctx: FooterContext;
	readonly data: Pick<
		ReadonlyFooterDataProvider,
		"getGitBranch" | "getExtensionStatuses" | "getAvailableProviderCount"
	>;
	readonly theme: Pick<Theme, "fg" | "bold">;
	/** Shortened to `~` in the working directory. */
	readonly home: Option.Option<string>;
	readonly thinkingLevel: () => string;
	/** Read again whenever the session gains an entry, so a `/settings` toggle shows after the next message. */
	readonly autoCompact: () => boolean;
}

/** What the stats line shows that only changes when the session gains an entry or the model changes. */
interface SessionStats {
	readonly cost: number;
	/** None when the session never read or wrote the cache, or the latest response sent no prompt tokens. */
	readonly cacheHitRate: Option.Option<number>;
	readonly context: ContextUsage | undefined;
	readonly autoCompact: boolean;
}

const minPadding = 2;

export const formatTokens = (count: number) => {
	if (count < 1000) {
		return count.toString();
	}

	if (count < 10_000) {
		return `${(count / 1000).toFixed(1)}k`;
	}

	if (count < 1_000_000) {
		return `${Math.round(count / 1000)}k`;
	}

	if (count < 10_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M`;
	}

	return `${Math.round(count / 1_000_000)}M`;
};

const usageOf = (entry: SessionEntry): Option.Option<Usage> => {
	if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
		return Option.fromNullishOr(entry.usage);
	}

	if (entry.type !== "message") {
		return Option.none();
	}

	const { message } = entry;

	return message.role === "assistant" || message.role === "toolResult"
		? Option.fromNullishOr(message.usage)
		: Option.none();
};

const responseUsageOf = (entry: SessionEntry): Option.Option<Usage> =>
	entry.type === "message" && entry.message.role === "assistant" ? Option.some(entry.message.usage) : Option.none();

const hitRate = (usage: Usage): Option.Option<number> => {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;

	return promptTokens > 0 ? Option.some((usage.cacheRead / promptTokens) * 100) : Option.none();
};

/** Counts every entry, not just those after a compaction, as pi's footer does. */
export const sessionUsage = (entries: ReadonlyArray<SessionEntry>) => {
	const usages = Arr.getSomes(Arr.map(entries, usageOf));
	const usedCache = Arr.some(usages, (usage) => usage.cacheRead > 0 || usage.cacheWrite > 0);

	return {
		cost: Arr.reduce(usages, 0, (sum, usage) => sum + usage.cost.total),
		cacheHitRate: usedCache ? Option.flatMap(Arr.findLast(entries, responseUsageOf), hitRate) : Option.none(),
	};
};

const formatCwd = (cwd: string, home: Option.Option<string>) => {
	if (Option.isNone(home)) {
		return cwd;
	}

	if (cwd === home.value) {
		return "~";
	}

	return Str.startsWith(`${home.value}/`)(cwd) ? `~${Str.slice(home.value.length)(cwd)}` : cwd;
};

/** Removes newlines, tabs, and runs of spaces, so a status stays on one line. */
const oneLine = (text: string) => {
	const spaced = Str.replaceAll(/[\r\n\t]/gu, " ")(text);

	return Str.trim(Str.replaceAll(/ +/gu, " ")(spaced));
};

const contextPart = ({ ctx, theme }: FooterInputs, { context, autoCompact }: SessionStats) => {
	const window = formatTokens(context?.contextWindow ?? ctx.model?.contextWindow ?? 0);
	const percent = context?.percent ?? undefined;
	const text = `${percent === undefined ? "?" : `${percent.toFixed(1)}%`}/${window}${autoCompact ? " (auto)" : ""}`;

	if (percent !== undefined && percent > 90) {
		return theme.fg("error", text);
	}

	if (percent !== undefined && percent > 70) {
		return theme.fg("warning", text);
	}

	return text;
};

const statsLeft = (inputs: FooterInputs, stats: SessionStats) => {
	const { model, modelRegistry } = inputs.ctx;
	// Kimi Coding bills a subscription through an API key, so pi counts it as one.
	const subscription = model !== undefined && (model.provider === "kimi-coding" || modelRegistry.isUsingOAuth(model));
	const cachePart = Option.map(stats.cacheHitRate, (rate) => `CH${rate.toFixed(1)}%`);

	const costPart =
		stats.cost > 0 || subscription
			? Option.some(`$${stats.cost.toFixed(3)}${subscription ? " (sub)" : ""}`)
			: Option.none();

	const parts = Arr.getSomes([cachePart, costPart]);

	return Arr.join([...parts, contextPart(inputs, stats)], " ");
};

const modelLabel = ({ ctx: { model }, thinkingLevel }: FooterInputs) => {
	if (model === undefined) {
		return "no-model";
	}

	if (!model.reasoning) {
		return model.id;
	}

	const level = thinkingLevel();

	return level === "off" ? `${model.id} • thinking off` : `${model.id} • ${level}`;
};

/** The model name with its provider in front, when several providers are available and the line has room. */
const modelPart = (inputs: FooterInputs, room: number) => {
	const label = modelLabel(inputs);
	const { model } = inputs.ctx;

	if (model === undefined || inputs.data.getAvailableProviderCount() <= 1) {
		return label;
	}

	const withProvider = `(${model.provider}) ${label}`;

	return visibleWidth(withProvider) <= room ? withProvider : label;
};

const statsLine = (inputs: FooterInputs, stats: SessionStats, width: number) => {
	const { theme } = inputs;
	const left = truncateToWidth(statsLeft(inputs, stats), width, "...");
	const room = width - visibleWidth(left) - minPadding;
	const right = truncateToWidth(modelPart(inputs, room), Math.max(0, room), "");
	const padding = Str.repeat(width - visibleWidth(left) - visibleWidth(right))(" ");

	// The context percent carries its own color, whose reset would end an outer dim, so each side is dimmed alone.
	return right === "" ? theme.fg("dim", left) : theme.fg("dim", left) + theme.fg("dim", padding + right);
};

const pwdLine = ({ ctx, data, theme, home }: FooterInputs, width: number) => {
	const branch = data.getGitBranch();
	const name = ctx.sessionManager.getSessionName();
	const cwd = formatCwd(ctx.sessionManager.getCwd(), home);
	const withBranch = branch === null ? cwd : `${cwd} (${branch})`;
	const pwd = name === undefined || name === "" ? withBranch : `${withBranch} • ${name}`;

	return truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
};

const byKey = Order.mapInput(Str.Order, ([key]: readonly [string, string]) => key);

const statusLines = ({ data, theme }: FooterInputs, width: number) => {
	const statuses = Arr.map(Arr.sort([...data.getExtensionStatuses()], byKey), ([, text]) => oneLine(text));

	return Arr.isReadonlyArrayNonEmpty(statuses)
		? [truncateToWidth(Arr.join(statuses, " "), width, theme.fg("dim", "..."))]
		: [];
};

/** Renders pi's footer with a stats line of cache hit rate, cost, and context use, and no token counters. */
export const footerView = (inputs: FooterInputs) => {
	const { ctx } = inputs;
	let cached = Option.none<{ readonly key: string; readonly stats: SessionStats }>();

	/** The footer renders on every frame, so it scans the session only when the leaf moves, as every append does. */
	const stats = () => {
		const session = ctx.sessionManager;
		const key = `${session.getSessionId()}:${session.getLeafId() ?? ""}:${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;

		if (Option.isSome(cached) && cached.value.key === key) {
			return cached.value.stats;
		}

		const fresh = {
			...sessionUsage(session.getEntries()),
			context: ctx.getContextUsage(),
			autoCompact: inputs.autoCompact(),
		};

		cached = Option.some({ key, stats: fresh });

		return fresh;
	};

	return (width: number) => [pwdLine(inputs, width), statsLine(inputs, stats(), width), ...statusLines(inputs, width)];
};

/**
 * Replaces pi's footer with `footerView`. It matches pi's built-in footer except for the stats line, and except that it
 * never shows where a virtual model routed the latest response, because pi gives extensions no way to tell a virtual
 * model apart.
 */
export const footer = (pi: Pick<ExtensionAPI, "on" | "getThinkingLevel">) => {
	pi.on("session_start", (_event, ctx) =>
		Effect.runPromise(
			Effect.gen(function* () {
				if (ctx.mode !== "tui") {
					return;
				}

				const home = yield* Effect.option(Config.String("HOME"));
				const settings = { projectTrusted: ctx.isProjectTrusted() };
				const autoCompact = () => SettingsManager.create(ctx.cwd, getAgentDir(), settings).getCompactionEnabled();

				ctx.ui.setFooter((tui, theme, data) => ({
					render: footerView({ ctx, data, theme, home, thinkingLevel: () => pi.getThinkingLevel(), autoCompact }),
					invalidate: Function.constVoid,
					dispose: data.onBranchChange(() => {
						tui.requestRender();
					}),
				}));
			}),
		),
	);
};
