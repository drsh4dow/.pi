---
name: game-design
description: Guides opinionated, commercially aware game design with player fantasy, appeal, fun, scope discipline, and design-as-search decisions. Use when designing or critiquing games, prototypes, Steam pitches, trailers, mechanics, loops, progression, game feel, hooks, fantasy, fun, appeal, scope, monetization, pivots, playtests, local minima, or team design disagreements.
---

# Game Design

## Core model

Design is a search algorithm over a huge design space. Every prototype, mock screenshot, rebalance, playtest, market comparison, and cut is a measurement. Improve the search process, not only the current design.

Design the appeal before the mechanics. Players buy the fantasy, vibe, promise, and screenshots before they understand the systems. If the pitch is not desirable, better mechanics rarely save it.

Optimize for:

```text
quality = (fun * appeal) / scope
appeal = (presentation + fantasy) * readability
```

- **Appeal** gets players: "I need to be there / do that / master that / see what happens."
- **Fun** keeps players: challenge, agency, mastery, surprise, flow.
- **Scope** decides whether the game ships and whether the return justifies the work.
- **Monetization** matters, but decide it after the core promise is strong unless the business model defines the game.

## Default workflow

1. **Name the reward function:** joy, portfolio, art, learning, revenue, or something else.
2. **Identify the search phase:** exploration, preproduction, or production.
3. **Name the player fantasy** in one sentence.
4. **Define the trailer moment:** the 5-15 seconds that makes someone say "I need to play this."
5. **Choose the proven base:** genre, camera, controls, session length, platform expectations.
6. **Add one sharp difference:** fantasy, mechanic, simulation, tech, structure, or presentation.
7. **Cut scope until the promise survives:** fewer verbs, fewer content types, fewer systems.
8. **Measure the riskiest assumption** with the cheapest artifact and a continue/pivot/kill rule.

Start with a pitch deck, Steam page mock, key art, or trailer sketch before implementation. Treat implementation as expensive evidence gathering, not the first design step. Exception: pure mechanics-first games, e.g. Balatro-like designs, where the core fun is the pitch.

## Search strategy

- **Go wide first, narrow later:** explore many directions cheaply, then tighten around the strongest one.
- **Exploration:** try fantasies, genres, modes, and mechanics. Optimize for learning speed, not code quality.
- **Preproduction:** search in a smaller radius. Lock the fantasy, controls, loop, art direction, and production risks.
- **Production:** trade search accuracy for speed. Commit, build, polish, but keep occasional measurements and playtests.
- **Use the database:** compare with shipped games, reviews, sales signals, communities, and past projects. Stay near proven successes without cloning them or becoming unreadably alien.
- **Escape local minima:** when cheap, try big jumps: alternate mode/objective, complete rebalance, different controls, new fantasy/framing, removing a core system, or extreme tuning.
- **Reduce measurement noise:** for expensive decisions, measure twice with more testers, a time gap, or a different artifact.

## Appeal paths

Prefer proven appeal plus one meaningful twist. Avoid originality for its own sake.

- **Fantasy first:** "be a witch running a cursed bakery", "pilot a living submarine". Strong for marketing, may constrain mechanics.
- **Iterate a proven formula:** safer; win through sharper fantasy, pacing, usability, or content curation.
- **Market gap / unique hook:** high upside, but validate; unique hooks must be instantly legible like Portal.
- **Translate other media:** borrow emotional texture from films, books, anime, tabletop, or history; be tasteful, not derivative.
- **Tech advantage:** simulation, destruction, scale, AI, procedural depth, or performance competitors cannot cheaply copy.

## Taste checks

Good concepts produce at least one strong urge: "I want to be that", "explore that place", "prove myself", "tinker with that system", "see how that story unfolds", or "spend time in that mood."

Weak concepts need long explanations. Strong concepts survive as one image, one sentence, and one verb.

## Prototype rules

- Minimize exploration cost so you can explore more, not less; use the fastest artifact that answers the question.
- Test art/readability and gameplay/fun separately before merging; building both together is just making the game.
- Use ugly code for disposable prototypes; use maintainable code once the direction survives.
- If an idea depends heavily on existing systems, prototype inside the main project.
- Parallelize with one person per scout when possible; prefer more scouts over bigger scouts.
- Debate less, scout more. If discussion would take longer than a prototype, send the prototype.

## Team decision rules

- Do not "just do both" when directions conflict; it usually creates scope creep and mush.
- For competing prototypes, swap owners for a while. Each captain improves and critiques the other's branch, reducing ego and sunk-cost bias.
- Split final authority by domain when useful: art director owns visual calls, gameplay lead owns systems calls.
- Keep the number of captains small. Crew members can search locally; ship-level direction needs fast decisions.

## Useful lenses

- **Flow** (Mihaly Csikszentmihalyi): tune challenge so the player feels stretched, not bored or crushed.
- **Actionable Gamification** (Yu-kai Chou): check motivation beyond rewards: mastery, ownership, scarcity, social pressure, unpredictability, meaning.
- **Appeal:** presentation plus fantasy, multiplied by readability. Can players understand the fantasy and gameplay from one screenshot or two seconds of footage?

## Common traps

- **Mechanics-first blindness:** a clever system nobody wants to inhabit.
- **Local minimum:** polishing a weak idea instead of making a big jump.
- **Alien originality:** too unfamiliar to read; combine familiar frame + novel edge.
- **Scope inflation:** every added system taxes content, UI, balance, QA, and onboarding.
- **Wrong reward function:** optimizing lore, engine architecture, or novelty instead of appeal, fun, and shippability.
- **Measurement noise:** overreacting to tiny feedback; measure twice only where decisions are expensive.
- **Bad search hygiene:** never scrapping work, constantly scrapping work, or scrapping work too late.

## Response pattern

When advising, be concrete, opinionated, and willing to push back. State the reward function and search phase, likely fantasy and audience, strongest appeal factor, biggest scope risk, highest-risk unknown, 2-3 sharper alternatives or big jumps, and the cheapest next measurement with continue/pivot/kill criteria.
