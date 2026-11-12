import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme } from "herdr";
import { agentTree, keyOf } from "./context.js";

const ICON = { skill: "mods/ow-skills/skill.svg", principle: "mods/ow-skills/principle.svg", playbook: "mods/ow-skills/playbook.svg" };
const FADE = 260;

const kindColor = (t, kind) => ({ skill: t.ansi4, principle: t.ansi5, playbook: t.ansi2 })[kind];
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function about(guide) {
  const how = guide.state === "partial" ? "Partly in context" : "In context";
  const who = guide.by === "person" ? ", loaded by you" : "";
  return `${how}${who}\n${guide.path}`;
}

export default class Skills extends View {
  init() {
    this.root = null;
    this.shown = new Map();
    this.leaving = new Map();
    this.entering = new Set();
  }

  // Keeps what just left for one fade, and marks what just arrived so it fades in on the next frame.
  track(root, agents, cx) {
    const now = new Map();
    for (const agent of agents) for (const guide of agent.context.loaded) now.set(keyOf(agent.address, guide), { agent: agent.address, guide });
    if (root !== this.root) {
      this.root = root; this.shown = now; this.leaving.clear(); this.entering.clear();
      return;
    }
    let left = false, arrived = false;
    for (const [key, item] of this.shown) if (!now.has(key)) { this.leaving.set(key, item); left = true; }
    for (const key of now.keys()) if (!this.shown.has(key)) { this.entering.add(key); this.leaving.delete(key); arrived = true; }
    this.shown = now;
    if (arrived) cx.timer.after(30, (cx) => { this.entering.clear(); cx.notify(); });
    if (left) cx.timer.after(FADE + 60, (cx) => { this.leaving.clear(); cx.notify(); });
  }

  // Each agent's guides with the ones fading out kept at the end, so nothing jumps while it fades.
  guidesOf(agent) {
    const live = agent.context.loaded.map((guide) => ({ guide, key: keyOf(agent.address, guide), gone: false }));
    const gone = [...this.leaving].filter(([, item]) => item.agent === agent.address).map(([key, item]) => ({ guide: item.guide, key, gone: true }));
    return [...live, ...gone];
  }

  fade(el, key, gone) {
    return el.id(key).opacity(gone || this.entering.has(key) ? 0 : 1).transition("opacity", { duration: FADE, easing: "ease-out" });
  }

  header(t, agents) {
    const loaded = agents.flatMap((a) => a.context.loaded);
    const count = (kind) => new Set(loaded.filter((g) => g.kind === kind).map((g) => g.path)).size;
    const available = agents[0]?.context.available;
    const stat = (kind, label) => h_flex().gap(5).items_center()
      .child(svg(ICON[kind]).size(12).text_color(kindColor(t, kind)))
      .child(div().text_color(t.foreground).child(String(count(kind))))
      .child(div().text_color(t.dim).child(available?.[kind] !== undefined ? `/ ${available[kind]} ${label}` : label));
    return h_flex().h(42).flex_none().px(14).gap(12).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Skills"))
      .child(div().flex_1())
      .child(h_flex().gap(12).text_size(11).child(stat("skill", "skills")).child(stat("principle", "principles")).child(stat("playbook", "playbooks")));
  }

  empty(t, title, body) {
    return v_flex().flex_1().items_center().justify_center().gap(6).p(24)
      .child(h_flex().gap(6).text_color(t.dim).child(svg(ICON.skill).size(16)).child(svg(ICON.principle).size(16)).child(svg(ICON.playbook).size(16)))
      .child(div().text_color(t.muted).font_semibold().child(title))
      .child(div().text_size(12).text_color(t.dim).text_center().max_w(240).child(body));
  }

  agentName(agent) {
    return agent.depth === 0 ? agent.terminal.program?.name ?? "Pi" : agent.terminal.name || agent.address;
  }

  agentCaption(t, agent) {
    const status = agent.terminal.status;
    return h_flex().gap(7).items_center().min_w(0)
      .child(div().size(7).flex_none().rounded(4).bg(t[status] ?? t.idle)
        .when(status === "working", (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1400 })))
      .child(div().truncate().font_semibold().text_color(t.foreground).child(this.agentName(agent)))
      .when(agent.depth > 0, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child("delegate")));
  }

  // Each agent's guides in the order they entered its context, on a rail.
  timeline(t, agents) {
    const row = ({ guide, key, gone }) => this.fade(h_flex(), key, gone).h(26).gap(10).items_center().tooltip(about(guide))
      .child(div().w(9).flex_none().flex().justify_center()
        .child(div().size(9).rounded(5).border_2().border_color(kindColor(t, guide.kind)).bg(guide.state === "partial" ? t.background : kindColor(t, guide.kind))))
      .child(div().flex_1().min_w(0).truncate().text_color(guide.state === "partial" ? t.muted : t.foreground).child(guide.name))
      .child(h_flex().flex_none().gap(6).items_center().text_size(10).text_color(t.dim)
        .when(guide.by === "person", (el) => el.child(div().text_color(t.ansi3).child("you")))
        .when(guide.state === "partial", (el) => el.child(div().child("partial")))
        .child(div().text_color(kindColor(t, guide.kind)).child(guide.kind)));
    return agents.map((agent) => {
      const items = this.guidesOf(agent);
      return v_flex().id(`line-${agent.address}`).ml(agent.depth * 16).gap(4)
        .child(this.agentCaption(t, agent))
        .child(v_flex().ml(3).pl(10).border_l(1).border_color(t.border).py(2)
          .children(items.map(row))
          .when(items.length === 0, (el) => el.child(div().h(24).text_size(12).text_color(t.dim).child("Nothing loaded"))));
    });
  }

  render(cx) {
    const t = theme();
    const { root, agents } = agentTree();
    this.track(root?.address ?? null, agents, cx);
    const loaded = agents.some((a) => a.context.loaded.length > 0) || this.leaving.size > 0;
    const body = agents.length === 0
      ? this.empty(t, "No pi agent here", "Focus a pi terminal to see the skills, principles and playbooks in its context.")
      : !loaded
        ? this.empty(t, "Nothing in context", `${plural(agents.length, "agent")} running. Skills, principles and playbooks show here as they are read.`)
        : v_flex().id("skills-list").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(14)
          .children(this.timeline(t, agents));
    return v_flex().id("skills").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .child(this.header(t, agents))
      .child(body);
  }
}
