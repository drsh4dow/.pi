import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, terminals, focused, theme } from "herdr";

// Each root pi writes what its session tree has spent to this label on its own terminal (~/.pi/features/cost).
const LABEL = "pi.cost";
const SHOWN = 6;

function parse(terminal) {
  try {
    const value = JSON.parse(terminal?.labels?.[LABEL] ?? "");
    return Array.isArray(value?.delegates) ? value : null;
  } catch {
    return null;
  }
}

function money(usd) {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

const sum = (list) => list.reduce((total, x) => total + x.usd, 0);

// The pi sessions in the shown tab, with their delegates at every level. Delegates sit in their root's tab.
function tabSpend() {
  const tab = focused()?.tab;
  const here = agents().filter((a) => a.tab === tab);
  const byAddress = new Map(terminals().map((t) => [t.address, t]));
  const labels = here.map((a) => parse(byAddress.get(a.address))).filter(Boolean);
  if (labels.length === 0) return null;
  const delegates = labels.flatMap((l) => l.delegates);
  const own = labels.reduce((total, l) => total + l.own, 0);
  return { sessions: labels.length, own, delegates, total: own + sum(delegates), working: here.some((a) => a.status === "working") };
}

function breakdown(spend) {
  const top = [...spend.delegates].sort((a, b) => b.usd - a.usd);
  const rest = top.slice(SHOWN);
  return [
    `${money(spend.total)} at API list prices`,
    `${spend.sessions === 1 ? "This session" : `${spend.sessions} sessions`}  ${money(spend.own)}`,
    ...top.slice(0, SHOWN).map((d) => `${d.name}  ${money(d.usd)}`),
    ...(rest.length > 0 ? [`${rest.length} more delegates  ${money(sum(rest))}`] : []),
    "What the API would charge, whatever your plan bills.",
  ].join("\n");
}

export default class WorkspaceStatus extends View {
  cost(t, spend) {
    const count = spend.delegates.length;
    return h_flex().id("cost").gap(6).items_center().tooltip(breakdown(spend))
      .child(svg("mods/ow-status/coins.svg").size(13).text_color(t.ansi3)
        .when(spend.working, (el) => el.loop("opacity", { from: 0.45, to: 1, period: 1400 })))
      .child(div().text_color(t.foreground).child(money(spend.total)))
      .child(div().text_color(t.dim).child(count > 0 ? `API · ${count} delegate${count === 1 ? "" : "s"}` : "API"));
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const spend = tabSpend();
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .when(spend !== null, (el) => el.child(this.cost(t, spend)));
  }
}
