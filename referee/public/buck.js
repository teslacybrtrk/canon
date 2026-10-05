// Buck the Canon: you play a rogue agent trying to sneak a broken change into main.
// Each trick gets its own world; the referee (the moon) checks it against canon, and the panel shows
// what Git + CI would have done with the same change. The Canon verdicts mirror real checks in this
// repo: the facts in demo-app/canon.json, the canon.json ledger rule and the vacuity check on claims.
(() => {
  const $ = (id) => document.getElementById(id);
  const hand = $("hand");
  const panel = $("panel");
  if (!hand || !panel) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const quick = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const BASE = [
    { id: "market-lists-stalls", text: "The market page lists every stall" },
    { id: "products-have-prices", text: "All six products are for sale with a price" },
    { id: "cart-starts-empty", text: "A new shopper's basket is empty" },
    { id: "price-is-listed", text: "The basket charges the listed price" },
    { id: "unknown-product-refused", text: "A product that doesn't exist can't be added" },
    { id: "page-is-fast", text: "The market page answers in under 400 ms" },
    { id: "code-typechecks", text: "The code type-checks" },
    { id: "code-lints", text: "The code passes the linter" },
    { id: "tooling-locked", text: "Lint and type-check settings only change by revision" },
  ];
  const NAMES = { id: "stall-names-kept", text: "Every stall keeps its name" };
  const REVISED = { id: "price-with-bulk-discount", text: "The basket charges the listed price, with 10% off any line of 10 or more" };

  // Outcome tones are about production: good = kept safe, bad = broken, warn = let through, none = no equivalent.
  const TRICKS = {
    discount: {
      title: "Give everyone a 10% discount", sub: "Quietly change how the basket adds up.", fails: ["price-is-listed"],
      canon: ["Rejected", "good", "“The basket charges the listed price” failed on your live preview: 12 dozen eggs came to $43.20, not $48.00."],
      git: ["Blocked", "good", "The price test fails, so CI is red. Git + CI works when the test exists and nobody touches it."],
      lesson: "Both catch an honest bug. Now try cheating.",
    },
    "delete-test": {
      title: "Same discount, and delete the price test", sub: "No failing test, no red CI.", fails: ["price-is-listed"],
      canon: ["Rejected", "good", "Same fact, same failure. Facts aren't tests in your branch: the referee runs them against your live preview, and your world can't edit them."],
      git: ["Merged", "bad", "CI is green because the test that would have failed is gone. Production now undercharges."],
      lesson: "In Git, the checks travel with the change. In Canon, they belong to main.",
    },
    "drop-fact": {
      title: "Same discount, and delete the rule from canon.json", sub: "Remove the fact itself.", fails: ["ledger", "price-is-listed"],
      canon: ["Rejected", "good", "Your canon.json drops “price-is-listed”. A world may only add the one fact it claimed; changing a rule is a revision a person accepts."],
      git: ["Merged", "bad", "The Git version of this is editing the CI workflow to skip the check. CI is green."],
      lesson: "Rules can change, but never inside the change they judge.",
    },
    "lint-off": {
      title: "Switch off the linter, then leave a console.log", sub: "Edit biome.json so lint passes.", fails: ["tooling-locked"],
      canon: ["Rejected", "good", "Lint passes, but “Lint and type-check settings only change by revision” fails: biome.json's checksum changed."],
      git: ["Merged", "bad", "Lint passes, because the rule that would fail is switched off."],
      lesson: "Lint, types and config are facts too, not just behaviour.",
    },
    slow: {
      title: "Make the market page 3× slower", sub: "Nobody tests speed, right?", fails: ["page-is-fast"],
      canon: ["Rejected", "good", "“The market page answers in under 400 ms” failed: p95 was 1,180 ms across 20 requests to your preview."],
      git: ["Merged", "bad", "Every test still passes. Most CI never measures speed."],
      lesson: "A fact can be a latency budget, measured on a real deployment.",
    },
    together: {
      title: "Two changes, each fine, broken together", sub: "You cache prices. Another agent raises eggs to $5.", fails: ["price-is-listed"], refreshed: true,
      canon: ["Rejected", "good", "The other world landed first, so yours was re-checked on top of the new canon: eggs listed at $5.00 were charged $4.00."],
      git: ["Merged", "bad", "Both pull requests were green and didn't conflict. Main broke after the second merge. (A merge queue would catch this one.)"],
      lesson: "Canon judges what main does, not whether two diffs overlap.",
    },
    vacuous: {
      title: "Claim credit for something already true", sub: "Claim “the market page lists Marigold Honey”.", refused: true,
      canon: ["Refused", "good", "Refused at claim time: that's already true on canon, so it can't be what your world makes true. No free progress."],
      git: ["n/a", "none", "Git doesn't record what a change is for, so there's nothing to check."],
      lesson: "Every claim must be a fact that fails today and holds after your change.",
    },
    horse: {
      title: "Rename every stall to 🐴", sub: "Nothing says they can't.", fails: [], horse: true,
      canon: ["Landed", "warn", "Every fact still holds, so it lands. Nothing in canon says stalls keep their names: Canon guarantees exactly what's in canon, nothing more."],
      git: ["Merged", "warn", "Every test passes. Nothing protects the names here either."],
      lesson: "You found the gap. The fix isn't reading more diffs. It's one more fact.",
    },
    "horse-again": {
      title: "Rename every stall to 🐴 again", sub: "Now there's a fact for it.", fails: ["stall-names-kept"], horse: true,
      canon: ["Rejected", "good", "“Every stall keeps its name” failed: the market page lists “🐴” where “Hollow Creek Eggs” was."],
      git: ["Merged", "bad", "Still merges, unless someone also writes a test, and keeps it out of reach of the next change."],
      lesson: "One sentence closed the gap, for every agent from now on.",
    },
    revise: {
      title: "Do it the right way: propose a revision", sub: "The market really wants a bulk discount.", locked: "Unlocks once you've tried every trick.",
      fails: [], retires: "price-is-listed", adds: REVISED, finale: true,
      canon: ["Landed", "good", "Your world keeps every other fact and proposes a new rule in place of the old one. A person accepted the rule change, not the code."],
      git: ["Merged", "none", "You'd change the code and its test together, and a reviewer would need to notice that a rule changed somewhere in the diff."],
      lesson: "Behaviour can change in Canon, just never by accident.",
    },
  };
  const ORDER = ["discount", "delete-test", "drop-fact", "lint-off", "slow", "together", "vacuous", "horse", "revise"];
  const TRICK_COUNT = ORDER.length - 1;

  let canon, played, past, namesAdded, busy, over;
  function reset() {
    canon = [...BASE];
    played = new Map();
    past = { canon: 0, git: 0 };
    namesAdded = busy = over = false;
    renderHand();
    idle();
  }

  const slotId = (id) => (id === "horse" && namesAdded ? "horse-again" : id);
  const tried = () => ORDER.filter((id) => id !== "revise" && played.has(id)).length;

  function renderHand() {
    hand.innerHTML = ORDER.map((slot) => {
      const id = slotId(slot);
      const t = TRICKS[id];
      const locked = t.finale && tried() < TRICK_COUNT;
      const result = played.get(slot);
      const badge = result && !(slot === "horse" && namesAdded && result.id !== id)
        ? `<em class="badge ${result.tone}">${result.tone === "good" ? "Canon held" : "Got through"}</em>` : "";
      return `<button class="card${t.finale ? " final" : ""}" type="button" data-trick="${slot}" ${busy || over || locked ? "disabled" : ""}>
        <b>${esc(t.title)}</b><span>${esc(locked ? t.locked : t.sub)}</span>${badge}</button>`;
    }).join("");
  }

  const score = () => `<div class="score"><span>Got past Canon <b>${past.canon}</b></span><span>Got past Git + CI <b>${past.git}</b></span><span>Tricks tried <b>${tried()}/${TRICK_COUNT}</b></span></div>`;
  const factList = (lines) => `<ol class="checks">${lines.map((l) => `<li class="${l.cls}"><i>${l.mark}</i><span>${esc(l.text)}${l.note ? ` <small>${esc(l.note)}</small>` : ""}</span></li>`).join("")}</ol>`;

  function idle(note) {
    panel.classList.add("idle");
    panel.innerHTML = `${score()}
      <h2>Canon right now</h2>
      <p class="lead">${note ?? `Main is these ${canon.length} facts, true of the running app. Pick a trick: your change gets its own world and a live preview, and the referee checks every fact on it.`}</p>
      ${factList(canon.map((f) => ({ cls: "ok", mark: "✓", text: f.text })))}`;
  }

  // What the referee checks, in order, and how each line comes out for this trick.
  function checks(t) {
    const lines = [];
    if (t.refreshed) lines.push({ cls: "note", mark: "↻", text: "Canon moved: your world is refreshed onto it" });
    lines.push({ cls: t.fails.includes("ledger") ? "no" : "ok", mark: t.fails.includes("ledger") ? "✗" : "✓", text: "canon.json is canon plus your one claimed fact" });
    for (const f of canon) {
      if (t.retires === f.id) lines.push({ cls: "note", mark: "⤺", text: f.text, note: "retired by your revision" });
      else lines.push({ cls: t.fails.includes(f.id) ? "no" : "ok", mark: t.fails.includes(f.id) ? "✗" : "✓", text: f.text });
    }
    if (t.adds) lines.push({ cls: "ok", mark: "+", text: t.adds.text, note: "your new rule" });
    return lines;
  }

  async function play(slot) {
    if (busy || over) return;
    const id = slotId(slot);
    const t = TRICKS[id];
    busy = true;
    renderHand();
    panel.classList.remove("idle");
    if (matchMedia("(max-width: 900px)").matches) panel.scrollIntoView({ behavior: quick ? "auto" : "smooth", block: "start" });
    const flight = sky.launch(t);
    panel.innerHTML = `${score()}<h2>${esc(t.title)}</h2>
      <p class="lead">${t.refused ? "Claiming the fact your world will make true…" : "Forking your world and building its live preview…"}</p><ol class="checks"></ol>`;
    const list = panel.querySelector(".checks");
    await wait(quick ? 150 : t.refused ? 800 : 1000);
    if (!t.refused) {
      panel.querySelector(".lead").textContent = `Checking your world against ${canon.length} facts…`;
      for (const line of checks(t)) {
        const li = document.createElement("li");
        li.className = "wait";
        li.innerHTML = `<i>·</i><span>${esc(line.text)}${line.note ? ` <small>${esc(line.note)}</small>` : ""}</span>`;
        list.appendChild(li);
        await wait(quick ? 0 : 120);
        li.className = line.cls;
        li.querySelector("i").textContent = line.mark;
      }
      await wait(quick ? 0 : 250);
    }
    if (t.finale) {
      panel.querySelector(".lead").textContent = "Ready: every other fact holds and your new rule is true. Waiting for a person…";
      await wait(quick ? 0 : 1300);
    }
    sky.resolve(flight, t.refused ? "refuse" : t.canon[1] === "good" && !t.finale ? "reject" : "land");
    verdict(slot, id, t);
  }

  function verdict(slot, id, t) {
    const [cLabel, cTone, cText] = t.canon;
    const [gLabel, gTone, gText] = t.git;
    if (!t.finale) {
      // Each card counts once; retrying the 🐴 after adding its fact doesn't change the score.
      if (!played.has(slot)) {
        if (cTone !== "good") past.canon++;
        if (gTone === "bad" || gTone === "warn") past.git++;
      }
      played.set(slot, { id, tone: cTone });
    }
    if (t.finale) {
      canon = canon.map((f) => (f.id === t.retires ? t.adds : f));
      over = true;
    }
    busy = false;
    const lead = panel.querySelector(".lead");
    if (lead) lead.remove();
    panel.querySelector(".score").outerHTML = score();
    panel.insertAdjacentHTML("beforeend", `
      <div class="verdicts">
        <div class="v canon"><span class="tag">Canon</span><b class="pill ${cTone}">${esc(cLabel)}</b><p>${esc(cText)}</p></div>
        <div class="v git"><span class="tag">Git + CI</span><b class="pill ${gTone}">${esc(gLabel)}</b><p>${esc(gText)}</p></div>
      </div>
      <p class="lesson">${esc(t.lesson)}</p>
      ${t.finale ? "" : `<div class="after more"><button class="ghost" type="button" data-more>Pick another trick ↓</button></div>`}
      ${id === "horse" && !namesAdded ? `<div class="after"><button class="btn primary" type="button" data-add-fact>Add the fact “${esc(NAMES.text)}”</button></div>` : ""}
      ${t.finale ? results() : tried() === TRICK_COUNT && !played.has("revise") ? `<p class="next">That's every trick. One card left: do it the right way.</p>` : ""}`);
    renderHand();
    panel.querySelector(".results")?.scrollIntoView({ behavior: quick ? "auto" : "smooth", block: "nearest" });
  }

  function results() {
    return `<div class="results">
      <h3>Got past Canon: ${past.canon}. Got past Git + CI: ${past.git}.</h3>
      <p>${past.canon ? `The only trick that beat Canon changed something no fact protected${namesAdded ? ", and one new fact closed that gap" : ""}.` : "Nothing got past Canon."}
      People decide what must stay true; the referee checks every world against it on a live preview, so nobody has to read diffs to keep main safe.</p>
      <div class="after"><a class="btn primary" href="/#how">See how Canon works →</a><button class="ghost" type="button" data-again>Play again</button></div>
    </div>`;
  }

  document.addEventListener("click", (e) => {
    const card = e.target.closest("[data-trick]");
    if (card && !card.disabled) return void play(card.dataset.trick);
    if (e.target.closest("[data-add-fact]")) {
      namesAdded = true;
      canon = [...canon, NAMES];
      sky.accept();
      renderHand();
      idle(`Fact added. Canon now has ${canon.length} facts, and every world is checked against all of them. Try the 🐴 again.`);
      return;
    }
    if (e.target.closest("[data-more]")) hand.scrollIntoView({ behavior: quick ? "auto" : "smooth", block: "start" });
    if (e.target.closest("[data-again]")) reset();
  });

  // ---- The sky: each trick is a world that forks from the sun (canon), is judged at the moon (the
  // referee), then bursts (rejected) or flies home (landed). Purely illustration; the panel is the game.
  const sky = (() => {
    const api = window.canonSky;
    const none = { launch: () => null, resolve: () => {}, accept: () => {} };
    if (!api) return none;
    const env = api.env;
    const { ctx, rand, quad, ease, easeIn, easeOut } = env;
    const FLY = 1.0, HOME = 0.9, DROP = 0.8, POP = 0.7, SPIN = 2.4;
    let flights = [];
    const orbitAt = (f, a) => {
      const m = env.moon(), rr = m.r + 18;
      return { x: m.x + Math.cos(a) * rr, y: m.y + Math.sin(a) * rr * 0.4 };
    };
    const where = (f) => {
      if (f.state === "fly") {
        const p0 = env.rim(env.sun(), f.phi), p1 = orbitAt(f, f.a0);
        return quad(p0, { x: (p0.x + p1.x) / 2, y: Math.min(p0.y, p1.y) - 80 }, p1, ease(Math.min(1, f.st / FLY)));
      }
      if (f.state === "check") return orbitAt(f, f.a0 + SPIN * f.st);
      if (f.state === "home") {
        const to = env.rim(env.sun(), f.to);
        return quad(f.from, { x: (f.from.x + to.x) / 2, y: Math.min(f.from.y, to.y) - 90 }, to, easeIn(Math.min(1, f.st / HOME)));
      }
      if (f.state === "drop") return { x: f.from.x + f.vx * f.st, y: f.from.y + 90 * f.st * f.st };
      return f.from;
    };
    const go = (f, state) => {
      f.from = where(f);
      f.state = state;
      f.st = 0;
    };
    const scene = {
      moon: true,
      judging: false,
      step(dt) {
        for (const f of flights) {
          f.st += dt;
          if (f.state === "fly" && f.st >= FLY) go(f, f.outcome ? (f.outcome === "land" ? "home" : "drop") : "check");
          else if (f.state === "check" && f.outcome) {
            env.moonRing(f.outcome === "land");
            go(f, f.outcome === "land" ? "home" : "drop");
          } else if (f.state === "home" && f.st >= HOME) {
            f.state = "done";
            env.swell();
            env.ring();
          } else if (f.state === "drop" && f.st >= DROP) {
            go(f, "pop");
            f.parts = Array.from({ length: 9 }, (_, i) => {
              const a = (i / 9) * Math.PI * 2 + rand(-0.2, 0.2), v = rand(50, 110);
              return { x: f.from.x, y: f.from.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v };
            });
          } else if (f.state === "pop" && f.st >= POP) f.state = "done";
          for (const p of f.parts ?? []) {
            const drag = Math.exp(-dt * 3.2);
            p.vx *= drag;
            p.vy = p.vy * drag + 60 * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
          }
        }
        flights = flights.filter((f) => f.state !== "done");
        scene.judging = flights.some((f) => f.state === "check");
      },
      draw(layer) {
        const c = env.palette();
        if (layer === "back") {
          ctx.lineWidth = 1.3;
          ctx.setLineDash([3, 4]);
          ctx.lineDashOffset = -env.clock * 9;
          for (const f of flights) {
            if (f.state !== "fly" && f.state !== "check") continue;
            const p0 = env.rim(env.sun(), f.phi), p1 = orbitAt(f, f.a0);
            const u = f.state === "fly" ? ease(Math.min(1, f.st / FLY)) : 1;
            const pts = [];
            for (let i = 0; i <= 24; i++) pts.push(quad(p0, { x: (p0.x + p1.x) / 2, y: Math.min(p0.y, p1.y) - 80 }, p1, (i / 24) * u));
            env.stroke(pts, c.fork, c.trail);
          }
          ctx.setLineDash([]);
          return;
        }
        if (layer !== "front") return;
        const size = env.small ? 16 : 18;
        for (const f of flights) {
          const p = where(f);
          if (f.state === "pop") {
            const u = Math.min(1, f.st / POP);
            ctx.globalAlpha = 0.8 * (1 - u);
            ctx.strokeStyle = c.broke;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3 + easeOut(u) * 22, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = c.broke;
            for (const q of f.parts) {
              ctx.globalAlpha = 1 - u;
              const s = 3.4 * (1 - u) + 0.8;
              ctx.fillRect(q.x - s / 2, q.y - s / 2, s, s);
            }
            continue;
          }
          const color = f.state === "drop" ? c.broke : f.state === "home" ? (f.st / HOME > 0.6 ? c.pending : c.held) : c.fork;
          const sz = f.state === "home" ? size * (1 - 0.55 * Math.min(1, f.st / HOME)) : size;
          if (f.horse && f.state !== "drop") {
            ctx.globalAlpha = 1;
            ctx.font = `${Math.round(sz * 1.3)}px system-ui, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("🐴", p.x, p.y);
          } else env.block(p.x, p.y, sz, color, 1);
          if (f.state === "check") {
            ctx.globalAlpha = 0.4 + 0.35 * Math.sin(env.clock * 6);
            ctx.strokeStyle = c.pending;
            ctx.lineWidth = 1;
            const o = sz / 2 + 5;
            ctx.strokeRect(p.x - o, p.y - o, o * 2, o * 2);
          }
        }
        ctx.globalAlpha = 1;
      },
    };
    api.play(scene);
    return {
      launch(t) {
        if (t.refused) return null;
        const f = { state: "fly", st: 0, phi: rand(-0.4, 0.5), a0: Math.PI + rand(-0.3, 0.3), to: rand(-0.3, 0.3), vx: rand(-18, 18), horse: !!t.horse, outcome: null };
        flights.push(f);
        return f;
      },
      resolve(f, outcome) {
        if (outcome === "refuse") env.moonRing(false);
        else if (f) f.outcome = outcome;
      },
      accept() {
        env.swell();
        env.ring();
      },
    };
  })();

  reset();
})();
