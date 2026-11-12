// What the panel shows: the skills, principles and playbooks each pi agent's model sees now. Each pi writes its own set to the
// `pi.context` label on its terminal (~/.pi/features/loaded), so this file only reads labels and walks parents.
import { focused, panes, terminals } from "herdr";

const LABEL = "pi.context";

function parse(terminal) {
  try {
    const value = JSON.parse(terminal.labels?.[LABEL] ?? "");
    return Array.isArray(value?.loaded) ? value : null;
  } catch {
    return null;
  }
}

// The terminal the person is looking at: the focused pane's, or the one an agent block shows.
function focusedTerminal() {
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return pane?.terminal ?? f?.terminal ?? f?.agent ?? null;
}

// The focused pi agent and every live pi below it, parents first. A terminal without the label, such as a serve, is
// passed through so its pi children still show.
export function agentTree() {
  const all = terminals();
  const root = all.find((t) => t.address === focusedTerminal());
  if (!root) return { root: null, agents: [] };
  const agents = [];
  const walk = (terminal, depth, parent) => {
    const context = parse(terminal);
    const here = context ? { address: terminal.address, terminal, depth, parent, context } : null;
    if (here) agents.push(here);
    for (const child of all.filter((k) => k.parent === terminal.address && k.state === "live")) {
      walk(child, here ? depth + 1 : depth, here?.address ?? parent);
    }
  };
  walk(root, 0, null);
  return { root, agents };
}

export const keyOf = (agent, guide) => `${agent}\u0000${guide.path}`;
