// Canon Rodeo: a 45-second game that shows why Canon exists.
// Round 1 runs main the Git way: you lasso pull requests into main by hand, can't keep up, and some
// merges break production. Round 2 runs it the Canon way: the moon (the referee) checks every world
// against every fact; you only accept facts, and near the end autopilot lands them for you.
(() => {
  const sky = window.canonSky;
  const hero = document.querySelector(".hero");
  const canvas = document.getElementById("sky");
  if (!sky || !hero || !canvas || window.canonRodeo) return;
  const env = sky.env;
  const { ctx, rand, quad, ease, easeIn, easeOut } = env;

  const ROUND = 22, AUTOPILOT_AT = 15, CANON_START = 9, BAD = 0.34;
  const REVIEW = 0.85, MERGE = 0.45, QUEUE = 0.5, FLY = 1.0, CHECK = 0.9, SPIN = 2.6, TOREADY = 0.8, HOME = 0.65, DROP = 0.7, POP = 0.6;
  // Facts the demo app keeps (demo-app/canon.json). A bad merge or a broken world breaks one of them.
  const FACTS = ["The basket charges the listed price", "The code passes the linter", "The code type-checks",
    "The page answers in under 400 ms", "Unknown products are refused", "A new basket is empty", "The market lists every stall"];
  // Facts agents try to make true.
  const CLAIMS = ["A sold-out product can't be added", "Shoppers can search by name", "Every stall shows its hours",
    "A basket line can't exceed 99 units", "Shoppers can remove an item", "Each product has its own page", "Each stall lists its products",
    "The basket shows a running total", "Prices show dollars and cents", "Vendors can mark a product sold out", "Search ignores upper and lower case",
    "An empty search shows every product", "The basket survives a reload", "Every stall has a vendor name", "Stall pages answer in under 400 ms",
    "No product has a negative price", "Checkout refuses an empty basket", "The basket counts items per product"];
  // Two goals that can't both be true: accepting one rejects the other.
  const CONFLICT = ["A stall cannot be double-booked", "Two vendors can share a stall"];

  let isOpen = false, round = 0, playing = false, time = 0, nextSpawn = 0, nextPR = 401, onClose = null;
  let items = [], floaters = [], lassos = [], scars = [], slots = [], pool = [], shown = new Set();
  let queued = 0, git = null, canon = null, autopilot = false, conflictDone = false, hudBottom = 140;
  let itemsRound = 0, busyNote = 0; // which round the sky's items belong to; they keep moving under the cards between rounds

  const lerp = (a, b, u) => a + (b - a) * Math.min(1, Math.max(0, u));
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const shuffle = (list) => list.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const size = () => (env.small ? 20 : 18);
  const gravity = () => 240 * (1 + 0.4 * (time / ROUND));

  // ---- Interface: HUD, tips and cards, styled with the page's tokens -------------------------------
  const style = document.createElement("style");
  style.textContent = `
    .hero.playing .sky { pointer-events: auto; touch-action: none; cursor: crosshair; }
    .hero.playing .ridge { pointer-events: none; }
    .rodeo { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
    .rodeo[hidden], .rodeo [hidden] { display: none !important; }
    .rodeo-top { position: absolute; top: 74px; left: 50%; transform: translateX(-50%); width: min(1200px, calc(100% - 32px)); display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .rodeo-hud { width: 100%; display: flex; align-items: center; gap: 10px 24px; flex-wrap: wrap; pointer-events: auto; }
    .rodeo-round { display: flex; flex-direction: column; gap: 8px; min-width: 190px; }
    .rodeo-round b { font: 800 24px/1 var(--display); text-transform: uppercase; letter-spacing: .01em; color: var(--ink); }
    .rodeo-time { display: block; height: 3px; border-radius: 3px; background: var(--line-2); overflow: hidden; }
    .rodeo-time i { display: block; height: 100%; width: 100%; background: var(--brand); }
    .rodeo-stats { display: flex; flex-wrap: wrap; gap: 6px 18px; font: 400 12px var(--mono); color: var(--ink-2); }
    .rodeo-stats b { color: var(--ink); font-weight: 500; }
    .rodeo-stats .bad { color: var(--broke); } .rodeo-stats .good { color: var(--held); }
    .rodeo-stats .auto { color: var(--brand); }
    .rodeo-x { position: absolute; top: 18px; right: max(20px, calc(50% - 600px)); pointer-events: auto; width: 36px; height: 36px; border-radius: 10px; cursor: pointer; color: var(--ink-2); background: var(--panel); border: 1px solid var(--line-2); font: 16px/1 var(--sans); backdrop-filter: blur(10px); }
    .rodeo-x:hover { color: var(--brand); border-color: var(--brand); }
    .rodeo-tip { margin: 0; max-width: 620px; text-align: center; font: 500 14.5px/1.45 var(--sans); color: var(--ink); background: var(--panel); border: 1px solid var(--line-2); border-radius: 12px; padding: 10px 16px; backdrop-filter: blur(10px); opacity: 0; transform: translateY(6px); transition: opacity .35s, transform .35s; }
    .rodeo-tip.on { opacity: 1; transform: none; }
    .rodeo-card { position: absolute; left: 50%; top: 52%; transform: translate(-50%, -50%); width: min(580px, calc(100% - 32px)); max-height: calc(100% - 120px); overflow: auto; pointer-events: auto;
      background: var(--panel-solid); border: 1px solid var(--line-2); border-radius: 18px; padding: 26px 26px 22px; box-shadow: 0 30px 80px -30px rgb(0 0 0 / .6); }
    .rodeo-card h3 { font: 800 clamp(30px, 4.4vw, 44px)/.95 var(--display); text-transform: uppercase; margin: 0 0 14px; color: var(--ink); }
    .rodeo-card h3 em { font-style: normal; color: var(--brand); }
    .rodeo-card p { color: var(--ink-2); margin: 0 0 10px; font-size: 15.5px; line-height: 1.5; }
    .rodeo-card p b { color: var(--ink); font-weight: 600; }
    .rodeo-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    .rodeo-ghost { display: inline-flex; align-items: center; font: 600 14.5px var(--sans); color: var(--ink); text-decoration: none; padding: 10px 16px; border-radius: 12px; border: 1px solid var(--line-2); background: transparent; cursor: pointer; }
    .rodeo-ghost:hover { border-color: var(--brand); color: var(--brand); }
    .rodeo-legend { display: flex; flex-direction: column; gap: 8px; margin: 14px 0 4px; font-size: 14px; color: var(--ink-2); }
    .rodeo-legend span { display: flex; align-items: center; gap: 10px; }
    .rodeo-legend i { width: 14px; height: 14px; flex: none; background: repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 5.3px); }
    .rodeo-legend .o { color: var(--brand); } .rodeo-legend .g { color: var(--held); } .rodeo-legend .r { color: var(--broke); } .rodeo-legend .m { color: var(--muted); }
    .rodeo-vs { width: 100%; border-collapse: collapse; margin: 6px 0 14px; font-size: 14.5px; }
    .rodeo-vs th { font: 700 18px/1 var(--display); text-transform: uppercase; text-align: right; padding: 0 0 8px; color: var(--muted); }
    .rodeo-vs th:last-child { color: var(--brand); }
    .rodeo-vs td { padding: 8px 0; border-top: 1px solid var(--line); color: var(--ink-2); }
    .rodeo-vs td + td { text-align: right; font: 500 15px var(--mono); color: var(--ink); width: 90px; }
    .rodeo-vs .bad { color: var(--broke) !important; } .rodeo-vs .good { color: var(--held) !important; }
    @media (max-width: 620px) { .rodeo-round { min-width: 0; flex: 1; } .rodeo-card { padding: 20px 18px 18px; } .rodeo-tip { font-size: 13.5px; } }
  `;
  document.head.appendChild(style);

  const ui = document.createElement("div");
  ui.className = "rodeo";
  ui.hidden = true;
  ui.innerHTML = `
    <div class="rodeo-top">
      <div class="rodeo-hud">
        <div class="rodeo-round"><b data-r="round">Canon Rodeo</b><span class="rodeo-time"><i data-r="time"></i></span></div>
        <div class="rodeo-stats" data-r="stats"></div>
      </div>
      <p class="rodeo-tip" data-r="tip" role="status"></p>
    </div>
    <div class="rodeo-card" data-r="card" hidden></div>
    <button class="rodeo-x" data-r="close" type="button" aria-label="Close the game" title="Close">✕</button>`;
  hero.appendChild(ui);
  const el = (k) => ui.querySelector(`[data-r="${k}"]`);

  let tipTimer = 0;
  function tip(text, once) {
    if (once) {
      if (shown.has(once)) return;
      shown.add(once);
    }
    const t = el("tip");
    t.textContent = text;
    t.classList.add("on");
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => t.classList.remove("on"), 5600);
  }

  function card(html, actions) {
    const c = el("card");
    c.innerHTML = `${html}<div class="rodeo-actions"></div>`;
    for (const a of actions) {
      const b = document.createElement(a.href ? "a" : "button");
      b.className = a.primary ? "btn primary" : "rodeo-ghost";
      b.textContent = a.label;
      if (a.href) b.href = a.href;
      else b.type = "button";
      b.addEventListener("click", (e) => { if (a.run) { e.preventDefault(); a.run(); } });
      c.querySelector(".rodeo-actions").appendChild(b);
    }
    c.hidden = false;
    c.querySelector(".btn")?.focus({ preventScroll: true });
  }
  const hideCard = () => { el("card").hidden = true; };

  let lastStats = "";
  function hud() {
    el("round").textContent = round === 1 ? "Round 1 · Git" : round === 2 ? "Round 2 · Canon" : "Canon Rodeo";
    el("time").style.width = `${round && playing ? Math.max(0, 1 - time / ROUND) * 100 : round ? 0 : 100}%`;
    const html = round === 1
      ? `<span>Merged <b>${git.merged}</b></span><span>Broke production <b class="bad">${git.broke}</b></span><span>Waiting for review <b>${waitingGit()}</b></span>`
      : round === 2
        ? `<span>Canon <b>${canon.facts}</b> facts</span><span>Accepted <b class="good">${canon.accepted}</b></span><span>Rejected by the referee <b>${canon.rejected}</b></span><span>Broke production <b class="good">0</b></span>${autopilot ? `<span class="auto">Autopilot on</span>` : ""}`
        : "";
    if (html !== lastStats) {
      el("stats").innerHTML = html;
      lastStats = html;
    }
  }

  // ---- Flow: intro, round 1, result, round 2, final ---------------------------------------------
  function intro() {
    round = 0;
    hud();
    card(`<p class="kicker">Canon Rodeo · two rounds, 45 seconds</p>
      <h3>Round 1: <em>main is a branch</em></h3>
      <p>Agents open pull requests faster than anyone can read them. You're the reviewer: <b>click a pull request to lasso it into main.</b> The ones you miss pile up, waiting for review.</p>
      <p>About a third of them break the app, and from the outside you can't tell which. That's Git with a crowd of agents.</p>`,
    [{ label: "Start round 1", primary: true, run: () => begin(1) }]);
  }

  function begin(r) {
    round = itemsRound = r;
    time = 0;
    nextSpawn = 0.2;
    playing = true;
    autopilot = false;
    conflictDone = false;
    items = [];
    floaters = [];
    lassos = [];
    scars = [];
    queued = 0;
    hideCard();
    const top = ui.querySelector(".rodeo-hud").getBoundingClientRect().bottom - hero.getBoundingClientRect().top;
    hudBottom = top + 16;
    scene.moon = r === 2;
    if (r === 1) {
      git = { merged: 0, broke: 0, waiting: 0 };
      tip("Click a pull request to lasso it into main.");
    } else {
      canon = { accepted: 0, rejected: 0, facts: CANON_START, waiting: 0 };
      pool = shuffle(CLAIMS);
      slots = makeSlots();
      tip("Same agents. Now the moon checks every world against all 9 facts before anything can land.");
    }
    hud();
  }

  function finish() {
    playing = false;
    if (round === 1) {
      git.waiting = waitingGit();
      card(`<p class="kicker">Round 1 · Git</p>
        <h3>${git.merged} merged. <em>${git.broke} broke production.</em></h3>
        <p>You read ${git.merged} diff${git.merged === 1 ? "" : "s"}, and ${git.broke} of those clean-looking merges still broke the app. <b>${git.waiting} pull requests are still waiting for review.</b></p>
        <p>With dozens of agents, review is the bottleneck, and a diff can't tell you whether the app still works.</p>`,
      [{ label: "Round 2: try Canon →", primary: true, run: () => intro2() }]);
    } else {
      canon.waiting = autopilot ? 0 : items.filter((w) => w.state === "ready" || w.state === "toready").length;
      card(`<p class="kicker">Canon Rodeo · results</p>
        <h3>Same agents. <em>Two ways to run main.</em></h3>
        <table class="rodeo-vs">
          <tr><th></th><th>Git</th><th>Canon</th></tr>
          <tr><td>Landed in main</td><td>${git.merged}</td><td>${canon.accepted}</td></tr>
          <tr><td>Broke production</td><td class="${git.broke ? "bad" : ""}">${git.broke}</td><td class="good">0</td></tr>
          <tr><td>Diffs a person had to read</td><td>${git.merged}</td><td class="good">0</td></tr>
          <tr><td>Still waiting on a person</td><td>${git.waiting}</td><td>${canon.waiting}</td></tr>
        </table>
        <p>The referee rejected ${canon.rejected} broken world${canon.rejected === 1 ? "" : "s"} on its own. You only decided which facts should be true, and with autopilot, not even that.</p>
        <p><b>Main is not a branch. It's what must stay true.</b></p>`,
      [{ label: "Play again", primary: true, run: () => begin(1) }, { label: "See how Canon works →", href: "/#how" }]);
    }
    hud();
  }

  function intro2() {
    round = 0;
    scene.moon = true;
    hud();
    card(`<p class="kicker">Round 2 · Canon</p>
      <h3>Round 2: <em>main is what must stay true</em></h3>
      <p>Same agents, same pace. Main is now a set of <b>9 facts</b>, like “the basket charges the listed price”. The moon is Canon's referee: it checks every world against every fact on a live preview.</p>
      <div class="rodeo-legend">
        <span><i class="o"></i>Orange: being checked</span>
        <span><i class="r"></i>Red: broke a fact, so it's rejected for you</span>
        <span><i class="g"></i><span>Green: ready. <b>Click it to accept the fact it makes true.</b></span></span>
      </div>`,
    [{ label: "Start round 2", primary: true, run: () => begin(2) }]);
  }

  // ---- Round 1: pull requests ---------------------------------------------------------------------
  function spawnPR() {
    const { W, H } = env;
    const apex = rand(Math.max(hudBottom + 30, H * 0.2), H * 0.58);
    items.push({ kind: "pr", id: nextPR++, bad: Math.random() < BAD, x: rand(W * 0.06, W * 0.94), y: H + 12,
      vx: rand(-30, 30), vy: -Math.sqrt(2 * gravity() * (H + 12 - apex)), state: "air", st: 0 });
  }
  const waitingGit = () => queued + items.filter((p) => p.kind === "pr" && (p.state === "air" || p.state === "queue")).length;
  const reviewing = () => items.find((p) => p.kind === "pr" && p.state === "review");
  // Missed pull requests slide along the horizon into the review queue, a heap at the bottom left.
  function heapSlot(k) {
    const per = env.small ? 5 : 7, s = size(), gap = s + 3;
    const x0 = Math.max(22, env.W / 2 - 600);
    return { x: x0 + (k % per) * gap + s / 2, y: env.H - 46 - Math.floor(k / per) * gap - s / 2 };
  }

  function stepGit(dt) {
    const g = gravity();
    for (const p of items) {
      p.st += dt;
      if (p.state === "air") {
        p.vy += g * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < 14 || p.x > env.W - 14) p.vx = -p.vx;
        if (p.vy > 0 && p.y > env.H - 44) {
          p.slot = queued + items.filter((o) => o.state === "queue").length;
          p.state = "queue";
          p.st = 0;
          p.from = { x: p.x, y: env.H - 44 };
        }
      } else if (p.state === "queue" && p.st >= QUEUE) {
        p.state = "done";
        queued++;
        if (queued >= 8) tip("The review queue keeps growing. With dozens of agents, a person reading diffs is the bottleneck.", "queue");
      } else if (p.state === "review" && p.st >= REVIEW) {
        p.state = "merge";
        p.st = 0;
      } else if (p.state === "merge" && p.st >= MERGE) {
        p.state = "done";
        if (!playing) continue; // after the bell nothing counts
        git.merged++;
        const top = env.rim(env.sun(), p.to);
        if (p.bad) {
          git.broke++;
          scars.push({ frac: rand(0.12, 0.75), len: rand(0.3, 0.7), off: rand(-0.25, 0.25) });
          float(`✗ #${p.id} broke production: ${pick(FACTS)}`, top, "broke");
          tip("That merge looked fine and still broke production. Reading a diff doesn't tell you whether the app works.", "broke");
        } else {
          env.swell();
          float(`#${p.id} merged`, top, "ink");
        }
      }
    }
  }

  function posPR(p) {
    if (p.state === "air") return p;
    if (p.state === "review") return { x: p.from.x, y: p.from.y + Math.sin(p.st * 9) * 1.2 };
    if (p.state === "queue") {
      const to = heapSlot(p.slot);
      return { x: lerp(p.from.x, to.x, ease(Math.min(1, p.st / QUEUE))), y: lerp(p.from.y, to.y, ease(Math.min(1, p.st / QUEUE))) };
    }
    const to = env.rim(env.sun(), p.to);
    return quad(p.from, { x: (p.from.x + to.x) / 2, y: Math.min(p.from.y, to.y) - 90 }, to, easeIn(Math.min(1, p.st / MERGE)));
  }

  // ---- Round 2: worlds and the referee ------------------------------------------------------------
  function makeSlots() {
    const { W, H, small } = env;
    const top = hudBottom + 70, bottom = H - env.VIS - 50;
    const rows = 4, cols = Math.max(2, Math.floor((W - 80) / (small ? 165 : 230)));
    const m = env.moon();
    const out = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = 40 + ((c + 0.5) * (W - 80)) / cols + (r % 2 ? 18 : -18);
        const y = top + (r + 0.5) * ((bottom - top) / rows);
        if (Math.hypot(x - m.x, y - m.y) > m.r + 80) out.push({ x, y, w: (W - 80) / cols - 18, used: null });
      }
    }
    return out;
  }

  function spawnWorld(over = {}) {
    items.push({ kind: "world", state: "fly", st: 0, phi: rand(-0.5, 0.6), a0: Math.PI + rand(-0.3, 0.3), lane: Math.floor(rand(0, 4)),
      fate: Math.random() < BAD ? "reject" : "ready", reason: pick(FACTS), claim: pool.pop() ?? pick(CLAIMS), seed: rand(0, 6.3), slot: null, ...over });
  }
  const orbitAt = (w, a) => {
    const m = env.moon(), rr = m.r + 14 + w.lane * 6;
    return { x: m.x + Math.cos(a) * rr, y: m.y + Math.sin(a) * rr * 0.4 };
  };
  const slotPos = (w) => ({ x: w.slot.x, y: w.slot.y + Math.sin(env.clock * 2 + w.seed) * 3 });

  function posWorld(w) {
    switch (w.state) {
      case "fly": {
        const p0 = env.rim(env.sun(), w.phi), p1 = orbitAt(w, w.a0);
        return quad(p0, { x: (p0.x + p1.x) / 2, y: Math.min(p0.y, p1.y) - 70 }, p1, ease(Math.min(1, w.st / FLY)));
      }
      case "check": return orbitAt(w, w.a0 + SPIN * w.st);
      case "toready": {
        const to = slotPos(w);
        return quad(w.from, { x: (w.from.x + to.x) / 2, y: Math.min(w.from.y, to.y) - 50 }, to, ease(Math.min(1, w.st / TOREADY)));
      }
      case "ready": return w.slot ? slotPos(w) : orbitAt(w, w.a0 + SPIN * (w.st + CHECK));
      case "home": {
        const to = env.rim(env.sun(), w.to);
        return quad(w.from, { x: (w.from.x + to.x) / 2, y: Math.min(w.from.y, to.y) - 80 }, to, easeIn(Math.min(1, w.st / HOME)));
      }
      case "drop": return { x: w.from.x + w.vx * w.st, y: w.from.y + 85 * w.st * w.st };
      default: return w.from;
    }
  }
  const pos = (it) => (it.kind === "pr" ? posPR(it) : posWorld(it));
  function go(w, state) {
    w.from = posWorld(w);
    w.state = state;
    w.st = 0;
  }

  function verdict(w) {
    if (w.fate !== "ready") return reject(w);
    env.moonRing(true);
    const slot = slots.find((s) => !s.used);
    if (slot) {
      slot.used = w;
      w.slot = slot;
      go(w, "toready");
    } else go(w, "ready");
    if (!autopilot) tip("Green means ready: it keeps every fact and makes a new one true. Click it to accept that fact.", "ready");
  }

  function reject(w) {
    env.moonRing(false);
    if (playing) canon.rejected++;
    if (w.slot) w.slot.used = null;
    w.slot = null;
    w.vx = rand(-18, 18);
    go(w, "drop");
    float(w.against ? `✗ contradicts “${w.against}”` : `✗ breaks “${w.reason}”`, w.from, "broke");
    if (!w.against) tip("Rejected by the referee: that world broke a fact, so it can never land. Nobody had to read its diff.", "rejected");
  }

  function accept(w, auto) {
    if (w.slot) w.slot.used = null;
    w.slot = null;
    w.to = rand(-0.35, 0.35);
    go(w, "home");
    if (!auto) lasso(w.from);
    if (w.conflict == null) return;
    const rival = items.find((o) => o.conflict === 1 - w.conflict && o.fate === "ready" && !["home", "drop", "pop", "done"].includes(o.state));
    if (!rival) return;
    rival.fate = "reject";
    rival.against = w.claim;
    if (rival.state === "ready" || rival.state === "toready") reject(rival);
    tip("Accepting a fact re-checks every other world. That one contradicts the fact you just accepted, so it can't land: a real conflict, caught without reading code.");
  }

  function stepCanon(dt) {
    for (const w of items) {
      w.st += dt;
      if (w.state === "fly" && w.st >= FLY) go(w, "check");
      else if (w.state === "check" && w.st >= CHECK) verdict(w);
      else if (w.state === "toready" && w.st >= TOREADY) go(w, "ready");
      else if (w.state === "ready" && autopilot && w.st > 0.25 + (w.seed % 1) * 0.6) accept(w, true);
      else if (w.state === "home" && w.st >= HOME) {
        w.state = "done";
        if (!playing) continue;
        canon.accepted++;
        canon.facts++;
        env.swell();
        env.ring();
        float(`+ ${w.claim}`, env.rim(env.sun(), w.to), "held");
      } else if (w.state === "drop" && w.st >= DROP) {
        go(w, "pop");
        w.parts = Array.from({ length: 9 }, (_, i) => {
          const a = (i / 9) * Math.PI * 2 + rand(-0.2, 0.2), v = rand(50, 110);
          return { x: w.from.x, y: w.from.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v };
        });
      } else if (w.state === "pop" && w.st >= POP) w.state = "done";
      for (const f of w.parts ?? []) {
        const drag = Math.exp(-dt * 3.2);
        f.vx *= drag;
        f.vy = f.vy * drag + 60 * dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
      }
    }
    scene.judging = items.some((w) => w.state === "check");
  }

  // ---- Effects --------------------------------------------------------------------------------------
  function float(text, at, tone) {
    let y = at.y - 18;
    while (floaters.some((f) => env.clock - f.born < 1.6 && Math.abs(f.x - at.x) < 200 && Math.abs(f.y - y) < 22)) y -= 24;
    floaters.push({ text, x: at.x, y, tone, born: env.clock });
    if (floaters.length > 6) floaters.shift();
  }
  const lasso = (at) => lassos.push({ x: at.x, y: at.y, born: env.clock });

  function label(text, x, y, color, alpha, font, maxW) {
    const c = env.palette();
    ctx.font = font;
    let t = text;
    if (maxW && ctx.measureText(t).width > maxW) {
      while (t.length > 6 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
      t = `${t.trimEnd()}…`;
    }
    const w = ctx.measureText(t).width;
    const cx = Math.min(env.W - w / 2 - 10, Math.max(w / 2 + 10, x));
    ctx.globalAlpha = alpha * 0.92;
    ctx.fillStyle = c.panel;
    ctx.beginPath();
    ctx.roundRect(cx - w / 2 - 7, y - 10, w + 14, 20, 6);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(t, cx, y + 0.5);
  }

  // ---- The scene the sky runs ----------------------------------------------------------------------
  const scene = {
    moon: false,
    judging: false,
    step(dt) {
      if (playing) {
        time += dt;
        nextSpawn -= dt;
        if (nextSpawn <= 0) {
          if (round === 1) spawnPR();
          else spawnWorld();
          nextSpawn = lerp(0.75, 0.3, time / ROUND);
        }
        if (round === 2 && !conflictDone && time > 4.5) {
          conflictDone = true;
          spawnWorld({ claim: CONFLICT[0], conflict: 0, fate: "ready", lane: 0 });
          spawnWorld({ claim: CONFLICT[1], conflict: 1, fate: "ready", lane: 2, phi: rand(-0.5, 0) });
        }
        if (round === 2 && !autopilot && time >= AUTOPILOT_AT) {
          autopilot = true;
          tip("Autopilot on: with one line in canon.json, ready worlds land by themselves. People decide which facts matter; agents do the rest.");
        }
        if (time >= ROUND) finish();
      }
      if (itemsRound === 1) stepGit(dt);
      else if (itemsRound === 2) stepCanon(dt);
      items = items.filter((it) => it.state !== "done");
      floaters = floaters.filter((f) => env.clock - f.born < 2.4);
      lassos = lassos.filter((l) => env.clock - l.born < 0.5);
      if (isOpen) hud();
    },
    draw(layer) {
      const c = env.palette();
      if (layer === "back") {
        // Dashed branches from the sun to the moon for worlds on their way to be checked.
        ctx.lineWidth = 1.3;
        ctx.setLineDash([3, 4]);
        ctx.lineDashOffset = -env.clock * 9;
        for (const w of items) {
          if (w.kind !== "world" || (w.state !== "fly" && w.state !== "check")) continue;
          const p0 = env.rim(env.sun(), w.phi), p1 = orbitAt(w, w.a0);
          const pts = [];
          const u = w.state === "fly" ? ease(Math.min(1, w.st / FLY)) : 1;
          for (let i = 0; i <= 24; i++) pts.push(quad(p0, { x: (p0.x + p1.x) / 2, y: Math.min(p0.y, p1.y) - 70 }, p1, (i / 24) * u));
          env.stroke(pts, c.fork, c.trail * (w.state === "check" ? 0.5 : 1));
        }
        ctx.setLineDash([]);
        return;
      }
      if (layer === "mid") {
        // Production broke: each bad merge leaves a red scar across the sun.
        const s = env.sun(), top = s.y - env.R;
        ctx.fillStyle = c.broke;
        for (const sc of scars) {
          const y = top + sc.frac * (env.H - 46 - top);
          const half = Math.sqrt(Math.max(0, env.R ** 2 - (y - s.y) ** 2));
          const len = half * 2 * sc.len;
          ctx.globalAlpha = 0.9;
          ctx.fillRect(s.x + sc.off * half - len / 2, y, len, 3);
        }
        return;
      }
      const sz = size();
      // The review queue.
      for (let k = 0; k < queued; k++) {
        const p = heapSlot(k);
        env.block(p.x, p.y, sz, c.muted, 0.85);
      }
      if (queued) {
        const p = heapSlot(Math.max(0, queued - 1));
        label("Review queue", heapSlot(0).x + 46, p.y - sz - 6, c.ink, 0.9, `500 10.5px "Martian Mono", ui-monospace, monospace`);
      }
      for (const it of items) {
        const p = pos(it);
        if (!p) continue;
        if (it.kind === "pr") {
          if (it.state === "air") {
            env.block(p.x, p.y, sz, c.fork, 1);
            label(`#${it.id}`, p.x, p.y - sz / 2 - 13, c.muted, 0.85, `500 10px "Martian Mono", ui-monospace, monospace`);
          } else if (it.state === "review") {
            const from = env.rim(env.sun(), 0);
            ctx.lineWidth = 1.4;
            env.stroke([from, { x: (from.x + p.x) / 2, y: (from.y + p.y) / 2 + 20 }, p], c.pending, 0.7);
            env.block(p.x, p.y, sz, c.fork, 1);
            ctx.globalAlpha = 0.95;
            ctx.strokeStyle = c.pending;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(p.x, p.y, sz * 0.95, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, it.st / REVIEW));
            ctx.stroke();
            label(`reading #${it.id}'s diff…`, p.x, p.y - sz - 12, c.ink, 0.9, `500 10.5px "Martian Mono", ui-monospace, monospace`);
          } else if (it.state === "queue") env.block(p.x, p.y, sz, c.muted, 0.85);
          else env.block(p.x, p.y, sz * (1 - 0.5 * Math.min(1, it.st / MERGE)), c.fork, 1);
          continue;
        }
        if (it.state === "fly" || it.state === "check") {
          env.block(p.x, p.y, sz * 0.8, c.fork, 1);
          if (it.state === "check") {
            ctx.globalAlpha = 0.4 + 0.35 * Math.sin(env.clock * 6 + it.seed);
            ctx.strokeStyle = c.pending;
            ctx.lineWidth = 1;
            const o = sz * 0.4 + 4;
            ctx.strokeRect(p.x - o, p.y - o, o * 2, o * 2);
          }
        } else if (it.state === "toready" || it.state === "ready") {
          env.block(p.x, p.y, sz, c.held, 1);
          ctx.globalAlpha = 0.45 + 0.35 * Math.sin(env.clock * 3 + it.seed);
          ctx.strokeStyle = c.held;
          ctx.lineWidth = 1.2;
          const o = sz / 2 + 5;
          ctx.strokeRect(p.x - o, p.y - o, o * 2, o * 2);
          if (it.slot) label(it.claim, p.x, p.y + sz / 2 + 18, c.ink, Math.min(1, it.state === "ready" ? 1 : it.st / TOREADY), `500 12px Archivo, system-ui, sans-serif`, it.slot.w);
        } else if (it.state === "home") {
          const u = Math.min(1, it.st / HOME);
          env.block(p.x, p.y, sz * (1 - 0.55 * u), u > 0.6 ? c.pending : c.held, 1);
        } else if (it.state === "drop") env.block(p.x, p.y, sz * 0.8, c.broke, 1);
        else if (it.state === "pop" && it.parts) {
          const u = Math.min(1, it.st / POP);
          ctx.globalAlpha = 0.8 * (1 - u);
          ctx.strokeStyle = c.broke;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3 + easeOut(u) * 22, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = c.broke;
          for (const f of it.parts) {
            ctx.globalAlpha = 1 - u;
            const s = 3.4 * (1 - u) + 0.8;
            ctx.fillRect(f.x - s / 2, f.y - s / 2, s, s);
          }
        }
      }
      // Two ready worlds that can't both be true: a red dashed line between them.
      const pair = items.filter((w) => w.conflict != null && w.state === "ready" && w.slot && w.fate === "ready");
      if (pair.length === 2) {
        const [a, b] = pair.map(posWorld);
        ctx.setLineDash([4, 5]);
        ctx.lineDashOffset = -env.clock * 10;
        ctx.lineWidth = 1.4;
        env.stroke([a, b], c.broke, 0.75);
        ctx.setLineDash([]);
        label("can't both be true", (a.x + b.x) / 2, (a.y + b.y) / 2 - 2, c.broke, 0.95, `500 10.5px "Martian Mono", ui-monospace, monospace`);
        tip("These two goals can't both be true. Accept one and watch what happens to the other.", "pair");
      }
      // Lassos: a rope from the top of the sun to whatever you roped, with a loop around it.
      for (const l of lassos) {
        const u = (env.clock - l.born) / 0.5;
        const from = env.rim(env.sun(), 0);
        const reach = Math.min(1, u / 0.3);
        const ctrl = { x: (from.x + l.x) / 2, y: (from.y + l.y) / 2 + 40 };
        const pts = [];
        for (let i = 0; i <= 20; i++) pts.push(quad(from, ctrl, l, (i / 20) * reach));
        ctx.lineWidth = 1.6;
        env.stroke(pts, c.pending, 0.85 * (1 - Math.max(0, u - 0.3) / 0.7));
        if (reach >= 1) {
          ctx.beginPath();
          ctx.ellipse(l.x, l.y, sz * 0.95, sz * 0.75, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      for (const f of floaters) {
        const age = env.clock - f.born;
        const color = f.tone === "broke" ? c.broke : f.tone === "held" ? c.held : f.tone === "muted" ? c.muted : c.ink;
        label(f.text, f.x, f.y - easeOut(Math.min(1, age / 2.4)) * 26, color, Math.min(1, (2.4 - age) / 0.7), `500 12px Archivo, system-ui, sans-serif`, 380);
      }
      ctx.globalAlpha = 1;
    },
  };

  // ---- Input ------------------------------------------------------------------------------------------
  canvas.addEventListener("pointerdown", (e) => {
    if (!isOpen || !playing) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bestD = e.pointerType === "touch" ? 36 : 28;
    for (const it of items) {
      if (it.kind === "pr" ? it.state !== "air" : !["fly", "check", "toready", "ready", "drop"].includes(it.state)) continue;
      const p = pos(it);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) {
        best = it;
        bestD = d;
      }
    }
    if (!best) return;
    if (best.kind === "pr") {
      // A person reads one diff at a time.
      const busy = reviewing();
      if (busy) {
        if (env.clock - busyNote > 0.9) float(`Still reading #${busy.id}'s diff…`, { x, y }, "muted");
        busyNote = env.clock;
        tip("You can only read one diff at a time. That's the bottleneck.", "busy");
        return;
      }
      best.from = { x: best.x, y: best.y };
      best.to = rand(-0.35, 0.35);
      best.state = "review";
      best.st = 0;
      lasso(best.from);
    } else if (best.state === "ready" || best.state === "toready") accept(best, false);
    else if (best.state === "drop") float(`Refused: it breaks “${best.reason}”`, pos(best), "broke");
    else float("Still being checked. Wait for the verdict.", pos(best), "muted");
  });

  function open(opts = {}) {
    onClose = opts.onClose ?? close;
    isOpen = true;
    hero.classList.add("playing");
    ui.hidden = false;
    git = canon = null;
    itemsRound = 0;
    scene.moon = false;
    sky.play(scene);
    intro();
  }
  function close() {
    isOpen = playing = false;
    round = 0;
    items = [];
    floaters = [];
    lassos = [];
    scars = [];
    queued = 0;
    hideCard();
    el("tip").classList.remove("on");
    hero.classList.remove("playing");
    ui.hidden = true;
    sky.stop();
  }
  el("close").addEventListener("click", () => onClose());
  addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen) onClose(); });

  window.canonRodeo = { open, close };
})();
