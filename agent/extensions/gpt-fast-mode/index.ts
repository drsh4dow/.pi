import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// OpenAI currently documents Codex Fast mode for these models only.
export const SUPPORTED_MODELS: ReadonlySet<string> = new Set([
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5",
]);

// Codex calls this mode "fast" in config, but sends "priority" on the wire.
export const FAST_SERVICE_TIER = "priority";
export const CONFIG_FILE = "gpt-fast-mode.json";
export const CONFIG_FIELD = "pi-gpt-fast-mode";
export const DEFAULT_SHORTCUT = "ctrl+alt+m";
export const RESERVED_SHORTCUTS: ReadonlySet<string> = new Set([
  "ctrl+m",
  "enter",
  "return",
]);

type Shortcut = Parameters<ExtensionAPI["registerShortcut"]>[0];
type PiModel = { provider?: string; id?: string };
type UnknownRecord = Record<string, unknown>;
type ReadTextFile = (path: string, encoding: "utf8") => string;

type PiFileLoadOptions = {
  env?: Record<string, string | undefined>;
  home?: string;
  readFile?: ReadTextFile;
};

export function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`;
}

export function isSupportedModel(model: PiModel | undefined): boolean {
  if (!model?.provider || !model.id) return false;
  return SUPPORTED_MODELS.has(modelKey(model));
}

export function shouldApplyFastMode(
  model: PiModel | undefined,
  payload: unknown,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  const requestModel = (payload as UnknownRecord).model;
  return isSupportedModel(model) && requestModel === model?.id;
}

/** Return a provider payload requesting the Fast service tier. */
export function withFastServiceTier(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  return {
    ...(payload as UnknownRecord),
    service_tier: FAST_SERVICE_TIER,
  };
}

function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

/** Resolve a global Pi config path using the same locations as Pi itself. */
export function resolvePiFilePath(
  fileName: string,
  options: PiFileLoadOptions = {},
): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const piDir = env.PI_CODING_AGENT_DIR?.trim();

  return piDir
    ? join(resolve(expandHome(piDir, home)), fileName)
    : join(home, ".pi", "agent", fileName);
}

function normalizeShortcutList(values: unknown[]): string[] {
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((shortcut) => !RESERVED_SHORTCUTS.has(shortcut.toLowerCase()));
}

export function normalizeShortcutSetting(value: unknown): string[] {
  if (value === false || value === null) return [];
  if (Array.isArray(value)) return normalizeShortcutList(value);

  const shortcuts = normalizeShortcutList([value]);
  return shortcuts.length > 0 ? shortcuts : [DEFAULT_SHORTCUT];
}

function loadPiJson(
  fileName: string,
  options: PiFileLoadOptions,
): UnknownRecord | undefined {
  const readFile: ReadTextFile =
    options.readFile ?? ((path, encoding) => readFileSync(path, encoding));

  try {
    const parsed = JSON.parse(
      readFile(resolvePiFilePath(fileName, options), "utf8"),
    ) as unknown;

    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as UnknownRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read shortcuts from the global Pi keybindings JSON.
 * Uses the field `pi-gpt-fast-mode`. Missing or invalid config falls back to ctrl+alt+m.
 * Set the field to false or null to disable the shortcut entirely.
 */
export function loadShortcuts(options: PiFileLoadOptions = {}): string[] {
  const config = loadPiJson("keybindings.json", options);
  return config
    ? normalizeShortcutSetting(config[CONFIG_FIELD])
    : [DEFAULT_SHORTCUT];
}

/** Read the last Fast mode state from the extension's global config file. */
export function loadEnabled(options: PiFileLoadOptions = {}): boolean {
  return loadPiJson(CONFIG_FILE, options)?.enabled === true;
}

/** Atomically persist Fast mode for future sessions. */
export function saveEnabled(enabled: boolean): void {
  const configPath = resolvePiFilePath(CONFIG_FILE);
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;

  mkdirSync(dirname(configPath), { recursive: true });
  try {
    writeFileSync(temporaryPath, `${JSON.stringify({ enabled }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, configPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function announceState(ctx: ExtensionContext, enabled: boolean): void {
  if (!enabled) {
    ctx.ui.notify("GPT Fast mode disabled.");
    return;
  }

  if (isSupportedModel(ctx.model)) {
    ctx.ui.notify(
      `GPT Fast mode enabled (service_tier: ${FAST_SERVICE_TIER}).`,
    );
    return;
  }

  const model = ctx.model;
  const label = model?.provider && model.id ? modelKey(model) : "unknown model";
  ctx.ui.notify(
    `GPT Fast mode enabled, but ${label} is not supported.`,
    "warning",
  );
}

export default function fastModeExtension(pi: ExtensionAPI): void {
  let enabled = loadEnabled();

  function toggle(ctx: ExtensionContext): void {
    const nextEnabled = !enabled;
    try {
      saveEnabled(nextEnabled);
      enabled = nextEnabled;
      announceState(ctx, enabled);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not save GPT Fast mode: ${reason}`, "error");
    }
  }

  pi.registerCommand("fast", {
    description: `Toggle GPT Fast mode (service_tier: ${FAST_SERVICE_TIER})`,
    handler: async (_args, ctx) => toggle(ctx),
  });

  for (const shortcut of loadShortcuts()) {
    pi.registerShortcut(shortcut as Shortcut, {
      description: "Toggle GPT Fast mode",
      handler: toggle,
    });
  }

  pi.on("session_start", () => {
    enabled = loadEnabled();
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (enabled && shouldApplyFastMode(ctx.model, event.payload)) {
      return withFastServiceTier(event.payload);
    }
  });
}
