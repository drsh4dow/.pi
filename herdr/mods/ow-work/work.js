// What the panels show: the files in the state folder of the focused pi agent's root. Each pi writes the folder it last
// wrote to as the `pi.state` label on its own terminal (~/.pi/features/state-folder), so this file reads labels, walks
// parents and parses the files. ow-tabs counts action items with a copy of `stateFolder` and `actionLines`.
import { focused, panes, terminals } from "herdr";

const LABEL = "pi.state";

// The terminal the person is looking at: the focused pane's, or the one an agent block shows.
function focusedTerminal() {
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return pane?.terminal ?? f?.terminal ?? f?.agent ?? null;
}

// The state folder of the focused terminal's highest labeled ancestor, so a delegate shows its root's work.
export function stateFolder() {
  const byAddress = new Map(terminals().map((t) => [t.address, t]));
  let folder = null;
  for (let t = byAddress.get(focusedTerminal()); t; t = byAddress.get(t.parent)) folder = t.labels?.[LABEL] || folder;
  return folder;
}

// Bold and code marks read as noise in a plain line.
export const plain = (text) => text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");

// TODO.md: `## <name>` opens a group, `- [ ] n. text` is open, `- [x]` done, `- [-] ... skip: <reason>` skipped.
// The first open item is the current one. Any other line is kept as text in its group.
export function parseTodo(text) {
  const groups = [];
  let group = null;
  for (const line of text.split("\n")) {
    if (!line.trim() || /^# /.test(line)) continue;
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) { group = { name: plain(heading[1]), items: [] }; groups.push(group); continue; }
    if (!group) { group = { name: null, items: [] }; groups.push(group); }
    const item = line.match(/^\s*[-*]\s+\[([ xX-])\]\s+(?:(\d+)\.\s+)?(.*)$/);
    if (!item) { group.items.push({ state: "text", text: line.trim() }); continue; }
    const state = item[1] === " " ? "open" : item[1] === "-" ? "skipped" : "done";
    const skip = state === "skipped" ? item[3].match(/^(.*?)\s*skip:\s*(.*)$/) : null;
    group.items.push({ state, number: item[2] ?? null, text: plain(skip ? skip[1] : item[3]).replace(/\.$/, ""), reason: skip?.[2] ?? null });
  }
  const items = groups.flatMap((g) => g.items).filter((i) => i.state !== "text");
  const current = items.find((i) => i.state === "open");
  if (current) current.current = true;
  return { groups, total: items.length, resolved: items.filter((i) => i.state !== "open").length };
}

// decisions.tsv, newest first. A `start` row marks where a run began; a line without six cells is kept as text.
export function parseTrail(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("ts\tphase\t")) continue;
    const cells = line.split("\t");
    if (cells.length !== 6) { rows.push({ kind: "text", text: line.replaceAll("\t", "  ") }); continue; }
    const [ts, phase, decision, why, evidence, result] = cells;
    rows.push({ kind: phase === "start" ? "start" : "row", ts, phase, decision, why, evidence, result });
  }
  return rows.reverse();
}

function actionLines(text) {
  let fence = null;
  return text.split("\n").map((line) => {
    const match = line.match(/^\s*(`{3,}|~{3,})\s*(.*)$/);
    const fenced = fence !== null || match !== null;
    if (fence === null && match) fence = match[1];
    else if (fence !== null && match && match[2] === "" && match[1].startsWith(fence)) fence = null;
    return { line, fenced, startsItem: !fenced && line.startsWith("## ") };
  });
}

export function parseActions(text) {
  const items = [];
  const note = [];
  for (const { line, fenced, startsItem } of actionLines(text)) {
    if (startsItem) {
      items.push({ title: plain(line.slice(3).trim()), body: [] });
    } else if (items.length > 0) {
      const body = items[items.length - 1].body;
      if (!fenced && line.startsWith("**")) body.push("");
      body.push(line);
    } else if (line.trim() && !line.startsWith("# ")) {
      note.push(line.trim());
    }
  }
  return { items: items.map((i) => ({ title: i.title, body: i.body.join("\n").trim() })), note: note.join(" ") };
}
