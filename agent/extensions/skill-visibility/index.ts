import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  formatSkillsForPrompt,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Skill,
} from "@mariozechner/pi-coding-agent";

const SETTINGS_KEY = "skillVisibility";
const DONE_LABEL = "Done";
const SKILLS_SECTION_PATTERN =
  /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;

type SettingsDocument = Record<string, unknown> & {
  skillVisibility?: {
    hiddenSkills?: unknown;
  };
};

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      await pruneHiddenSkills(pi);
    } catch (error) {
      ctx.ui.notify(
        `Failed to prune hidden skills: ${errorMessage(error)}`,
        "warning",
      );
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    let hiddenSkills: Set<string>;
    try {
      hiddenSkills = await readHiddenSkills();
    } catch (error) {
      ctx.ui.notify(
        `Failed to read skill visibility settings: ${errorMessage(error)}`,
        "warning",
      );
      return;
    }

    if (hiddenSkills.size === 0 || !event.systemPromptOptions.skills?.length)
      return;

    const skills = applySkillVisibility(
      event.systemPromptOptions.skills,
      hiddenSkills,
    );
    const systemPrompt = replaceSkillsSection(event.systemPrompt, skills);
    if (systemPrompt) return { systemPrompt };
  });

  pi.registerCommand("skill-visibility", {
    description: "Toggle which skills are model-discoverable.",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/skill-visibility requires interactive UI", "warning");
        return;
      }

      const skillNames = listLoadedSkillNames(pi);
      if (skillNames.length === 0) {
        ctx.ui.notify("No skills are currently loaded.", "info");
        return;
      }

      let hiddenSkills: Set<string>;
      try {
        hiddenSkills = await readHiddenSkills();
      } catch (error) {
        ctx.ui.notify(
          `Failed to read skill visibility settings: ${errorMessage(error)}`,
          "error",
        );
        return;
      }

      await chooseSkillVisibility(ctx, skillNames, hiddenSkills);
    },
  });
}

async function chooseSkillVisibility(
  ctx: ExtensionCommandContext,
  skillNames: string[],
  hiddenSkills: Set<string>,
): Promise<void> {
  let skillName = await selectSkillName(ctx, skillNames, hiddenSkills);

  while (skillName) {
    toggleSetValue(hiddenSkills, skillName);

    try {
      await writeHiddenSkills(hiddenSkills);
    } catch (error) {
      ctx.ui.notify(
        `Failed to save skill visibility settings: ${errorMessage(error)}`,
        "error",
      );
      return;
    }

    const state = hiddenSkills.has(skillName)
      ? "hidden from model discovery"
      : "model-discoverable";
    ctx.ui.notify(`${skillName} is now ${state}.`, "info");

    skillName = await selectSkillName(ctx, skillNames, hiddenSkills);
  }
}

async function selectSkillName(
  ctx: ExtensionCommandContext,
  skillNames: string[],
  hiddenSkills: Set<string>,
): Promise<string | undefined> {
  const choices = skillChoices(skillNames, hiddenSkills);
  const selected = await ctx.ui.select("Skill visibility", [
    ...choices.keys(),
    DONE_LABEL,
  ]);

  if (!selected || selected === DONE_LABEL) return undefined;
  return choices.get(selected);
}

function skillChoices(
  skillNames: string[],
  hiddenSkills: Set<string>,
): Map<string, string> {
  const choices = new Map<string, string>();

  for (const skillName of skillNames) {
    const hidden = hiddenSkills.has(skillName);
    const marker = hidden ? "○" : "●";
    const status = hidden ? "hidden" : "discoverable";
    choices.set(`${marker} ${skillName} — ${status}`, skillName);
  }

  return choices;
}

function applySkillVisibility(
  skills: Skill[],
  hiddenSkills: Set<string>,
): Skill[] {
  return skills.map((skill) => ({
    ...skill,
    disableModelInvocation:
      skill.disableModelInvocation ||
      hiddenSkills.has(normalizeSkillName(skill.name)),
  }));
}

async function pruneHiddenSkills(pi: ExtensionAPI): Promise<void> {
  const installed = new Set(listLoadedSkillNames(pi));
  const hidden = await readHiddenSkills();
  const pruned = Array.from(hidden).filter((skillName) =>
    installed.has(skillName),
  );

  if (pruned.length !== hidden.size) await writeHiddenSkills(pruned);
}

function listLoadedSkillNames(pi: ExtensionAPI): string[] {
  const names = new Set<string>();

  for (const command of pi.getCommands()) {
    if (command.source !== "skill") continue;

    const name = normalizeSkillName(command.name);
    if (name) names.add(name);
  }

  return Array.from(names).sort();
}

function settingsPath(): string {
  return join(homedir(), ".pi", "agent", "settings.json");
}

async function readHiddenSkills(): Promise<Set<string>> {
  const settings = await readSettings();
  const hiddenSkills = settings[SETTINGS_KEY]?.hiddenSkills;

  if (!Array.isArray(hiddenSkills)) return new Set<string>();
  return new Set(normalizeSkillNames(hiddenSkills));
}

async function writeHiddenSkills(
  hiddenSkills: Iterable<string>,
): Promise<void> {
  const path = settingsPath();
  const settings = await readSettings();
  const names = normalizeSkillNames(hiddenSkills);

  if (names.length === 0) {
    deleteHiddenSkills(settings);
  } else {
    const section = isRecord(settings[SETTINGS_KEY])
      ? { ...settings[SETTINGS_KEY] }
      : {};
    section.hiddenSkills = names;
    settings[SETTINGS_KEY] = section;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

async function readSettings(): Promise<SettingsDocument> {
  try {
    const parsed = JSON.parse(
      await readFile(settingsPath(), "utf-8"),
    ) as unknown;
    return isRecord(parsed) ? (parsed as SettingsDocument) : {};
  } catch (error) {
    if (isNotFoundError(error)) return {};
    throw error;
  }
}

function deleteHiddenSkills(settings: SettingsDocument): void {
  const section = settings[SETTINGS_KEY];
  if (!isRecord(section)) return;

  delete section.hiddenSkills;
  if (Object.keys(section).length === 0) delete settings[SETTINGS_KEY];
}

function replaceSkillsSection(
  systemPrompt: string,
  skills: Skill[],
): string | undefined {
  const next = systemPrompt.replace(
    SKILLS_SECTION_PATTERN,
    formatSkillsForPrompt(skills),
  );
  return next === systemPrompt ? undefined : next;
}

function normalizeSkillNames(names: Iterable<unknown>): string[] {
  const normalized = new Set<string>();

  for (const name of names) {
    if (typeof name !== "string") continue;

    const normalizedName = normalizeSkillName(name);
    if (normalizedName) normalized.add(normalizedName);
  }

  return Array.from(normalized).sort();
}

function normalizeSkillName(name: string): string {
  return name.trim().replace(/^skill:/, "");
}

function toggleSetValue(values: Set<string>, value: string): void {
  if (values.has(value)) values.delete(value);
  else values.add(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
