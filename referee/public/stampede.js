// Canon Stampede: two 40-second rounds riding a stampede of agents' changes.
// Round 1 is Git: every change looks the same. Review one first (press and hold) or jump blind.
// Round 2 is Canon: the moon (the referee) checks every change against every fact; only green can land.
(() => {
  const cv = document.getElementById("stage");
  const ctx = cv.getContext("2d");
  const ui = document.querySelector(".ui");
  const el = (k) => ui.querySelector(`[data-r="${k}"]`);

  const ROUND = 40, RIDE = 3.6, JUMP = 0.42, REVIEW = 1.0, TAP = 0.22, ROLLBACK = 2.6, FALL = 1.6;
  const JUDGE = 0.6, RECHECK = 0.7, AUTOPILOT = 10, BAD = 0.32, SPEED = 260;
  // Facts the demo app keeps (demo-app/canon.json); a broken change breaks one of them.
  const FACTS = ["The basket charges the listed price", "The code passes the linter", "The code type-checks",
    "The page answers in under 400 ms", "Unknown products are refused", "A new basket is empty", "The market lists every stall"];
  // Facts agents are trying to make true.
  const CLAIMS = ["A sold-out product can't be added", "Shoppers can search by name", "Every stall shows its hours",
    "A basket line can't exceed 99 units", "Shoppers can remove an item", "Each product has its own page", "Each stall lists its products",
    "The basket shows a running total", "Prices show dollars and cents", "Vendors can mark a product sold out", "Search ignores case",
    "An empty search shows every product", "The basket survives a reload", "Every stall has a vendor name", "Stall pages answer in under 400 ms",
    "No product has a negative price", "Checkout refuses an empty basket", "The basket counts items per product", "Stalls show a map pin",
    "Honey shows its harvest date", "Eggs show how many are left", "The market shows today's date"];
  // Pairs of goals that can't both be true.
  const CONFLICTS = [["A stall can't be double-booked", "Two vendors can share a stall"], ["Prices include tax", "Tax is added at checkout"],
    ["Baskets expire after an hour", "The basket survives a reload"]];

  const PALETTE = {
    dark: { skyTop: "#010e20", skyLow: "#2a1a33", glow: "253,111,22", groundTop: "#0b1a33", groundLow: "#020b18", ridge: "#05122a", lines: "rgba(135,150,171,0.16)",
      fork: "#fd8a2c", held: "#4cc38a", broke: "#ff6b86", pending: "#fdc86d", main: "#fff1cc", past: "#55657d", ink: "#f5efe6", muted: "#8796ab",
      panel: "rgba(1,14,32,0.84)", moonLit: "#fbf3e4", moonDim: "#6f7d93", dust: "rgba(253,200,109,0.35)" },
    light: { skyTop: "#fbf6ef", skyLow: "#fde3c4", glow: "253,143,62", groundTop: "#efd2ad", groundLow: "#e2bb8c", ridge: "#d8ad7f", lines: "rgba(1,19,42,0.10)",
      fork: "#ed5616", held: "#1e7b4f", broke: "#c0264e", pending: "#b7791f", main: "#01132a", past: "#a08a72", ink: "#01132a", muted: "#5b6577",
      panel: "rgba(255,255,255,0.92)", moonLit: "#2a3a52", moonDim: "#01132a", dust: "rgba(1,19,42,0.18)" },
  };

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const shuffle = (list) => list.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
  const easeOut = (x) => 1 - (1 - x) ** 3;
  const quad = (a, c, b, t) => ({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * b.y });

  let W = 0, H = 0, small = false, horizon = 0, PX = 0, lanes = [], scales = [];
  let mode = null, playing = false, time = 0, clock = 0, last = 0;
  let herd = [], me = null, floaters = [], dust = [], lines = [], stars = [], ridge = [], scroll = 0;
  let press = null, nextSpawn = 0, nextConflict = 0, nextId = 401, pool = [], pairSeq = 0, landedPairs = new Map(), shown = new Set();
  let git = null, canon = null, theme = null, patterns = {}, moonShown = 0, beams = [];

  // ---- Layout ---------------------------------------------------------------------------------------
  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    W = innerWidth;
    H = innerHeight;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    small = W < 700;
    horizon = H * (small ? 0.46 : 0.44);
    const g = H - horizon;
    lanes = [horizon + g * 0.3, horizon + g * 0.56, horizon + g * 0.84];
    const base = small ? 0.72 : Math.min(1.15, Math.max(0.85, W / 1300));
    scales = [0.74 * base, 0.88 * base, 1.04 * base];
    PX = W * (small ? 0.2 : 0.24);
    stars = Array.from({ length: Math.round((W * horizon) / 7000) }, () => ({ x: rand(0, W), y: rand(0, horizon * 0.85), s: Math.random() < 0.12 ? 2 : 1, ph: rand(0, 6.3) }));
    lines = Array.from({ length: Math.round(W / 40) }, () => ({ x: rand(0, W), y: rand(horizon + 6, H), len: rand(20, 70) }));
    ridge = Array.from({ length: 40 }, (_, i) => ({ x: i / 39, h: rand(6, 22) }));
    theme = null;
  }

  function palette() {
    const t = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    if (t !== theme) {
      theme = t;
      patterns = {};
      for (const [k, color] of Object.entries(PALETTE[t])) {
        if (!color.startsWith("#")) continue;
        const c = document.createElement("canvas");
        c.width = 4;
        c.height = 4;
        const g = c.getContext("2d");
        g.fillStyle = color;
        g.fillRect(0, 0, 3, 4);
        patterns[k] = ctx.createPattern(c, "repeat");
      }
    }
    return PALETTE[t];
  }

  // ---- The herd -------------------------------------------------------------------------------------
  function spawn(extra = {}) {
    const fromRight = Math.random() < 0.75;
    const x = extra.x ?? (fromRight ? W + 80 : -80);
    // A lane with room at the edge, so animals don't spawn on top of each other.
    const lane = extra.lane ?? shuffle([0, 1, 2]).find((l) => herd.every((a) => a.lane !== l || Math.abs(a.x - x) > 130));
    if (lane == null) return;
    herd.push({
      id: nextId++, kind: Math.random() < 0.35 ? "bull" : "horse", lane,
      x, v: fromRight ? -rand(110, 220) : rand(70, 130), seed: rand(0, 6.3),
      bad: Math.random() < BAD, reason: pick(FACTS), claim: pool.pop() ?? pick(CLAIMS),
      pair: null, side: 0, state: "new", st: 0, reviewed: null, main: false, past: false, ...extra,
    });
  }
  function spawnConflict() {
    const pair = pairSeq++;
    const [a, b] = CONFLICTS[pair % CONFLICTS.length];
    const lanesFree = shuffle([0, 1, 2]);
    spawn({ pair, side: 0, claim: a, bad: false, lane: lanesFree[0], x: W + 80, v: -rand(130, 160) });
    spawn({ pair, side: 1, claim: b, bad: false, lane: lanesFree[1], x: W + 150, v: -rand(130, 160) });
  }
  const partnerLanded = (a) => a.pair != null && landedPairs.has(a.pair) && landedPairs.get(a.pair).side !== a.side;
  const brokenNow = (a) => a.bad || partnerLanded(a);
  const top = (a) => ({ x: a.x, y: lanes[a.lane] - 50 * scales[a.lane] });
  const center = (a) => ({ x: a.x, y: lanes[a.lane] - 26 * scales[a.lane] });

  function newMain() {
    const a = { id: nextId++, kind: "horse", lane: 1, x: PX, v: 0, seed: rand(0, 6.3), bad: false, reason: "", claim: "", pair: null, side: 0, state: "green", st: 0, reviewed: null, main: true, past: false, fresh: 0 };
    herd.push(a);
    me = { a, ride: 0, jump: null, down: null };
  }

  // ---- Rounds and cards -----------------------------------------------------------------------------
  function card(html, actions) {
    const c = el("card");
    c.innerHTML = `${html}<div class="actions"></div>`;
    for (const a of actions) {
      const b = document.createElement(a.href ? "a" : "button");
      b.className = a.primary ? "btn primary" : "ghost";
      b.textContent = a.label;
      if (a.href) b.href = a.href;
      else b.type = "button";
      b.addEventListener("click", (e) => { if (a.run) { e.preventDefault(); a.run(); } });
      c.querySelector(".actions").appendChild(b);
    }
    c.hidden = false;
    c.querySelector(".btn")?.focus({ preventScroll: true });
  }

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
    tipTimer = setTimeout(() => t.classList.remove("on"), 5200);
  }

  function intro() {
    mode = null;
    hud();
    card(`<p class="kicker">Canon Stampede · two rounds, 40 seconds each</p>
      <h3>Round 1: <em>Git</em></h3>
      <p>Every animal in the stampede is an agent's change. You're riding main. Your ride bucks you off after a few seconds, so keep lassoing the next one: <b>every safe landing ships a change.</b></p>
      <p><b>Tap an animal to jump.</b> About 1 in 3 is broken and they all look the same: land on one and production breaks. <b>Press and hold</b> to review one first, but your ride keeps bucking while you read.</p>`,
    [{ label: "Start round 1", primary: true, run: () => begin("git") }]);
  }

  function begin(m) {
    mode = m;
    time = 0;
    playing = true;
    herd = herd.filter((a) => a === me?.a);
    if (!me?.a) newMain();
    me.ride = 0;
    me.a.state = "green";
    nextSpawn = 0;
    nextConflict = m === "canon" ? 6 : 8;
    landedPairs = new Map();
    floaters = [];
    pool = shuffle(CLAIMS);
    el("card").hidden = true;
    if (m === "git") {
      git = { shipped: 0, broke: 0, review: 0, stale: 0, falls: 0 };
      tip("Tap an animal to jump onto it. Press and hold to review it first.");
    } else {
      canon = { shipped: 0, auto: 0, rejected: 0, falls: 0 };
      tip("The moon checks every change against every fact. Only green ones can land.");
    }
    for (let i = 0; i < 5; i++) spawn({ x: rand(PX + 140, W - 40) });
    hud();
  }

  function finish() {
    playing = false;
    press = null;
    if (mode === "git") {
      card(`<p class="kicker">Round 1 · Git</p>
        <h3>${git.shipped} shipped. <em>${git.broke} broke production.</em></h3>
        <p>You spent <b>${git.review.toFixed(1)} s reviewing</b>, and still couldn't be fast and safe at the same time.
        ${git.stale ? ` ${git.stale === 1 ? "One break was a change you'd reviewed" : `${git.stale} breaks were changes you'd reviewed`}: fine on its own, broken after another merge.` : " And a review can't tell you when two changes that each pass break together."}</p>`,
      [{ label: "Round 2: Canon →", primary: true, run: intro2 }]);
    } else {
      const total = canon.shipped + canon.auto;
      card(`<p class="kicker">Canon Stampede · results</p>
        <h3>Same herd. <em>Two ways to run main.</em></h3>
        <table class="vs">
          <tr><th></th><th>Git</th><th>Canon</th></tr>
          <tr><td>Changes shipped</td><td>${git.shipped}</td><td>${total}${canon.auto ? ` <small>(${canon.auto} by autopilot)</small>` : ""}</td></tr>
          <tr><td>Broke production</td><td class="${git.broke ? "bad" : ""}">${git.broke}</td><td class="good">0</td></tr>
          <tr><td>Seconds spent reviewing</td><td>${git.review.toFixed(1)}</td><td class="good">0</td></tr>
        </table>
        <p>The referee rejected ${canon.rejected} broken change${canon.rejected === 1 ? "" : "s"} before anyone could land on them, and re-checked the herd every time main moved.</p>
        <p><b>Same agents, same herd. Git made you choose between speed and safety. Canon gave you both.</b></p>`,
      [{ label: "Play again", primary: true, run: () => { shown.clear(); intro(); } }, { label: "See how Canon works →", href: "/#how" }]);
    }
    hud();
  }

  function intro2() {
    mode = null;
    hud();
    card(`<p class="kicker">Round 2 · Canon</p>
      <h3>Round 2: <em>Canon</em></h3>
      <p>Same stampede. Now the moon is the referee: it checks every change against every fact in canon, and colours it.</p>
      <div class="legend">
        <span><i class="g"></i><span><b>Green</b> keeps every fact and adds one. Lasso it.</span></span>
        <span><i class="r"></i><span><b>Red</b> breaks a fact. Your lasso won't catch it.</span></span>
        <span><i class="a"></i><span><b>Amber</b>: main just moved, so it's being re-checked.</span></span>
      </div>`,
    [{ label: "Start round 2", primary: true, run: () => begin("canon") }]);
  }

  let lastStats = "";
  function hud() {
    el("round").textContent = mode === "git" ? "Round 1 · Git" : mode === "canon" ? "Round 2 · Canon" : "Canon Stampede";
    el("time").style.width = `${mode ? Math.max(0, 1 - time / ROUND) * 100 : 100}%`;
    const html = mode === "git"
      ? `<span>Shipped <b>${git.shipped}</b></span><span>Broke production <b class="bad">${git.broke}</b></span><span>Reviewing <b>${git.review.toFixed(1)} s</b></span>`
      : mode === "canon"
        ? `<span>Shipped <b class="good">${canon.shipped + canon.auto}</b></span><span>Broke production <b class="good">0</b></span><span>Rejected by the referee <b>${canon.rejected}</b></span>${time >= ROUND - AUTOPILOT && playing ? `<span class="auto">Autopilot on</span>` : ""}`
        : "";
    if (html !== lastStats) {
      el("stats").innerHTML = html;
      lastStats = html;
    }
  }

  // ---- Moves ----------------------------------------------------------------------------------------
  const riderAt = () => {
    if (me.a) {
      const s = scales[me.a.lane];
      return { x: me.a.x - 2 * s, y: lanes[me.a.lane] - 44 * s };
    }
    return me.pos;
  };

  function lasso(t, auto = false) {
    if (!me.a || me.jump || me.down || t === me.a || t.past) return;
    const from = riderAt();
    if (Math.abs(t.x - from.x) > W * 0.62) return float("Too far to lasso", top(t), "muted");
    if (mode === "canon") {
      if (t.state === "red") return float(t.against ? `Refused: contradicts “${t.against}”` : `Refused: breaks “${t.reason}”`, top(t), "broke");
      if (t.state !== "green") return float("Still being checked", top(t), "muted");
    }
    me.jump = { st: 0, from, target: t, auto };
    me.a.main = false;
    me.a.past = true;
    me.a.v = -rand(70, 120);
    me.a = null;
    me.pos = from;
  }

  function land(t, auto) {
    me.jump = null;
    if (mode === "git" && brokenNow(t)) {
      git.broke++;
      if (t.reviewed === "ok") {
        git.stale++;
        tip("You reviewed that one and it was fine. It broke after another merge: two changes that each pass, broken together.", "stale");
      } else tip("That change was broken, and production went down with it. You're rolling back.", "broke");
      float(`✗ #${t.id} broke production: ${t.bad ? t.reason : "clashes with an earlier merge"}`, top(t), "broke");
      t.state = "red";
      t.past = true;
      me.down = { st: 0, dur: ROLLBACK, why: "Rolling back production…" };
      me.pos = top(t);
      return;
    }
    if (mode === "git") {
      git.shipped++;
      float(`+ #${t.id} merged`, top(t), "ink");
    } else if (mode === "canon") {
      if (auto) canon.auto++;
      else canon.shipped++;
      float(`+ ${t.claim}`, top(t), "held");
      // Main moved: every other ready change is re-checked against the new canon.
      for (const o of herd) if (o !== t && o.state === "green" && !o.past) { o.state = "behind"; o.st = 0; }
      if (herd.some((o) => o.state === "behind")) tip("Main moved, so every other change is being re-checked against it.", "behind");
    }
    if (t.pair != null) landedPairs.set(t.pair, t);
    t.main = true;
    t.state = "green";
    me.a = t;
    me.ride = 0;
  }

  function buck() {
    if (mode === "git") git.falls++;
    if (mode === "canon") canon.falls++;
    me.pos = riderAt();
    me.a.main = false;
    me.a.past = true;
    me.a = null;
    me.down = { st: 0, dur: FALL, why: "Bucked off. Back on main…" };
    tip("Your ride bucked you off. Keep moving: main has to keep shipping.", "buck");
  }

  // ---- Simulation -----------------------------------------------------------------------------------
  function step(dt) {
    clock += dt;
    scroll += SPEED * dt;
    if (playing) {
      time += dt;
      nextSpawn -= dt;
      if (nextSpawn <= 0) {
        spawn();
        nextSpawn = rand(0.55, 0.8);
      }
      if (time >= nextConflict) {
        spawnConflict();
        nextConflict = time + 11;
      }
      if (mode === "canon" && time >= ROUND - AUTOPILOT) tip("Autopilot on: with one line in canon.json, green changes land by themselves.", "auto");
      if (time >= ROUND) finish();
    }

    // The ridden animal drifts back to the rider's spot; the camera pans with it.
    if (me?.a) {
      const dx = (PX - me.a.x) * Math.min(1, dt * 2.2);
      for (const a of herd) a.x += dx;
      for (const f of floaters) f.x += dx;
    }
    for (const a of herd) {
      a.st += dt;
      if (a !== me?.a) a.x += a.v * dt;
      if (mode !== "canon") continue;
      if (a.state === "new" && a.x < W - 10 && a.x > 10 && !a.main) {
        a.state = "judging";
        a.st = 0;
        beams.push({ a, born: clock });
      } else if (a.state === "judging" && a.st >= JUDGE) {
        const bad = brokenNow(a);
        a.state = bad ? "red" : "green";
        if (bad && playing) canon.rejected++;
        if (bad && a.against == null && partnerLanded(a)) a.against = landedPairs.get(a.pair).claim;
        if (bad) tip("Red: the referee checked that change and it breaks a fact. It can never land, and nobody read its diff.", "red");
      } else if (a.state === "behind" && a.st >= RECHECK) {
        if (brokenNow(a)) {
          a.state = "red";
          a.against = partnerLanded(a) ? landedPairs.get(a.pair).claim : null;
          if (playing) canon.rejected++;
          if (a.against) tip("That change contradicts the fact you just landed, so it turned red. A real conflict, caught without reading code.", "conflict");
        } else a.state = "green";
      }
    }
    herd = herd.filter((a) => a === me?.a || (a.x > -140 && a.x < W + 200));

    if (me) {
      if (me.down) {
        me.down.st += dt;
        if (me.down.st >= me.down.dur) {
          me.down = null;
          newMain();
          me.a.fresh = 1;
        }
      } else if (me.jump) {
        me.jump.st += dt;
        if (me.jump.st >= JUMP) land(me.jump.target, me.jump.auto);
      } else if (me.a) {
        if (playing) me.ride += dt;
        if (me.ride >= RIDE) buck();
        else if (playing && mode === "canon" && time >= ROUND - AUTOPILOT && me.ride > 0.45) {
          const next = herd.filter((a) => a.state === "green" && !a.past && a !== me.a && a.x > PX - 40 && Math.abs(a.x - PX) < W * 0.6)
            .sort((p, q) => Math.abs(p.x - PX - 160) - Math.abs(q.x - PX - 160))[0];
          if (next) lasso(next, true);
        }
      }
      if (me.a?.fresh) me.a.fresh = Math.max(0, me.a.fresh - dt * 1.5);
    }

    // Reviewing (Git): hold on a change to read it; the ride keeps bucking meanwhile.
    if (press && mode === "git" && playing) {
      press.st += dt;
      if (press.st >= REVIEW && !press.done) {
        press.done = true;
        press.a.reviewed = press.a.bad ? "bad" : "ok";
        git.review += REVIEW;
        tip(press.a.bad ? "Reviewed: that one's broken. Good catch, but it cost you a second." : "Reviewed: looks fine. Tap it to jump.", press.a.bad ? "rev-bad" : "rev-ok");
      }
    }

    moonShown += ((mode === "canon" ? 1 : 0) - moonShown) * Math.min(1, dt * 2);
    beams = beams.filter((b) => clock - b.born < JUDGE + 0.2);
    floaters = floaters.filter((f) => clock - f.born < 2.2);
    for (const l of lines) {
      l.x -= SPEED * (0.6 + (l.y - horizon) / (H - horizon)) * dt;
      if (l.x + l.len < 0) {
        l.x = W + rand(0, 80);
        l.y = rand(horizon + 6, H);
      }
    }
    if (Math.random() < dt * 30) {
      const a = pick(herd);
      if (a) dust.push({ x: a.x - 18 * scales[a.lane], y: lanes[a.lane] - 2, vx: -rand(40, 90), born: clock, s: rand(1.5, 3) * scales[a.lane] });
    }
    for (const d of dust) d.x += d.vx * dt;
    dust = dust.filter((d) => clock - d.born < 0.9);
    if (mode) hud();
  }

  // ---- Drawing --------------------------------------------------------------------------------------
  function float(text, at, tone) {
    let y = at.y - 14;
    while (floaters.some((f) => clock - f.born < 1.4 && Math.abs(f.x - at.x) < 180 && Math.abs(f.y - y) < 22)) y -= 24;
    floaters.push({ text, x: at.x, y, tone, born: clock });
  }

  function label(text, x, y, color, alpha, font, maxW) {
    const c = palette();
    ctx.font = font;
    let t = text;
    if (maxW && ctx.measureText(t).width > maxW) {
      while (t.length > 6 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
      t = `${t.trimEnd()}…`;
    }
    const w = ctx.measureText(t).width;
    const cx = Math.min(W - w / 2 - 8, Math.max(w / 2 + 8, x));
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
    ctx.globalAlpha = 1;
  }

  function drawSky(c) {
    const g = ctx.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, c.skyTop);
    g.addColorStop(1, c.skyLow);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, horizon + 1);
    if (theme === "dark") {
      ctx.fillStyle = "#f5efe6";
      for (const s of stars) {
        ctx.globalAlpha = 0.12 + 0.35 * (0.5 + 0.5 * Math.sin(clock * 1.1 + s.ph));
        ctx.fillRect(s.x, s.y, s.s, s.s);
      }
      ctx.globalAlpha = 1;
    }
    // The sun on the horizon: canon, in the same scanlines as the site.
    const R = Math.min(W * 0.14, 150), sx = W * 0.66, sy = horizon + R * 0.3;
    const glow = ctx.createRadialGradient(sx, horizon, R * 0.4, sx, horizon, R * 3.2);
    glow.addColorStop(0, `rgba(${c.glow},0.45)`);
    glow.addColorStop(1, `rgba(${c.glow},0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, horizon);
    const body = ctx.createRadialGradient(sx, horizon, 0, sx, horizon, R);
    body.addColorStop(0, "#fff1cc");
    body.addColorStop(0.35, "#fdc86d");
    body.addColorStop(0.75, "#fd8a2c");
    body.addColorStop(1, "#ed5616");
    ctx.fillStyle = body;
    for (let x = Math.floor((sx - R) / 4) * 4; x < sx + R; x += 4) {
      const h = Math.sqrt(Math.max(0, R * R - (x + 1.5 - sx) ** 2));
      const t0 = sy - h;
      if (t0 < horizon) ctx.fillRect(x, t0, 3, horizon - t0);
    }
    // The moon: the referee. It only rises in the Canon round.
    if (moonShown > 0.01) {
      const mr = small ? 16 : 24, mx = W * (small ? 0.84 : 0.86), my = horizon * 0.3;
      const mg = ctx.createRadialGradient(mx, my, mr * 0.8, mx, my, mr * 3.4);
      mg.addColorStop(0, `rgba(205,218,238,${0.18 * moonShown})`);
      mg.addColorStop(1, "rgba(205,218,238,0)");
      ctx.fillStyle = mg;
      ctx.fillRect(mx - mr * 3.4, my - mr * 3.4, mr * 6.8, mr * 6.8);
      const mb = ctx.createLinearGradient(mx - mr, my - mr, mx + mr, my + mr);
      mb.addColorStop(0.15, c.moonLit);
      mb.addColorStop(1, c.moonDim);
      ctx.fillStyle = mb;
      ctx.globalAlpha = moonShown;
      for (let x = Math.floor((mx - mr) / 3) * 3; x < mx + mr; x += 3) {
        const h = Math.sqrt(Math.max(0, mr * mr - (x + 1 - mx) ** 2));
        if (h > 0) ctx.fillRect(x, my - h, 2, h * 2);
      }
      ctx.globalAlpha = 1;
      // Judging beams from the moon to the changes it's checking.
      ctx.lineWidth = 1.2;
      for (const b of beams) {
        if (b.a.state !== "judging") continue;
        const p = top(b.a);
        ctx.globalAlpha = 0.35 * moonShown;
        ctx.strokeStyle = c.pending;
        ctx.setLineDash([3, 5]);
        ctx.beginPath();
        ctx.moveTo(mx, my + mr);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
    }
    // Far ridge, scrolling slowly.
    ctx.fillStyle = c.ridge;
    ctx.beginPath();
    ctx.moveTo(0, horizon + 2);
    const off = (scroll * 0.08) % (W / 2);
    for (let k = 0; k < 2; k++) {
      for (const p of ridge) ctx.lineTo(p.x * W - off + k * W, horizon - p.h);
    }
    ctx.lineTo(W, horizon + 2);
    ctx.closePath();
    ctx.fill();
  }

  function drawGround(c) {
    const g = ctx.createLinearGradient(0, horizon, 0, H);
    g.addColorStop(0, c.groundTop);
    g.addColorStop(1, c.groundLow);
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, W, H - horizon);
    ctx.strokeStyle = c.lines;
    ctx.lineWidth = 1;
    for (const l of lines) {
      ctx.beginPath();
      ctx.moveTo(l.x, l.y);
      ctx.lineTo(l.x + l.len, l.y);
      ctx.stroke();
    }
    ctx.fillStyle = c.dust;
    for (const d of dust) {
      ctx.globalAlpha = 1 - (clock - d.born) / 0.9;
      ctx.fillRect(d.x, d.y - (clock - d.born) * 10, d.s, d.s);
    }
    ctx.globalAlpha = 1;
  }

  // A side-on animal in vertical scanlines, galloping. Origin at its feet.
  function drawAnimal(a, fill, alpha = 1) {
    const s = scales[a.lane];
    const ph = clock * 12 + a.seed;
    const bob = Math.sin(ph * 2) * 1.6;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(a.x, lanes[a.lane]);
    ctx.scale(s, s);
    ctx.fillStyle = fill;
    for (const [lx, p] of [[-16, 0], [-10, Math.PI], [12, Math.PI / 2], [18, Math.PI * 1.5]]) {
      ctx.save();
      ctx.translate(lx, -19 + bob);
      ctx.rotate(Math.sin(ph + p) * 0.55);
      ctx.fillRect(-2.4, 0, 4.8, 19);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.ellipse(0, -27 + bob, 25, 10.5, 0, 0, Math.PI * 2);
    ctx.fill();
    if (a.kind === "bull") {
      ctx.beginPath();
      ctx.ellipse(6, -35 + bob, 13, 7, -0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(18, -32 + bob);
      ctx.lineTo(30, -38 + bob);
      ctx.lineTo(38, -32 + bob);
      ctx.lineTo(36, -24 + bob);
      ctx.lineTo(24, -20 + bob);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(30, -44 + bob, 3, 7);
      ctx.fillRect(35, -43 + bob, 3, 6);
    } else {
      ctx.beginPath();
      ctx.moveTo(15, -32 + bob);
      ctx.lineTo(27, -46 + bob);
      ctx.lineTo(37, -43 + bob);
      ctx.lineTo(38, -36 + bob);
      ctx.lineTo(30, -35 + bob);
      ctx.lineTo(22, -22 + bob);
      ctx.closePath();
      ctx.fill();
    }
    ctx.lineWidth = 3;
    ctx.strokeStyle = fill;
    ctx.beginPath();
    ctx.moveTo(-24, -31 + bob);
    ctx.quadraticCurveTo(-34, -30 + bob + Math.sin(ph) * 3, -33, -19 + bob);
    ctx.stroke();
    ctx.restore();
  }

  // The rider: you, riding main. Hat, raised arm, like the icon.
  function drawRider(x, y, s, color, tilt = 0) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);
    ctx.scale(s, s);
    ctx.fillStyle = color;
    ctx.fillRect(-4, -14, 8, 16);
    ctx.beginPath();
    ctx.arc(0, -19, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-8, -24, 16, 2.4);
    ctx.fillRect(-4.5, -29, 9, 5.5);
    ctx.save();
    ctx.translate(3, -12);
    ctx.rotate(-2.3 + Math.sin(clock * 9) * 0.25);
    ctx.fillRect(0, -1.5, 13, 3);
    ctx.restore();
    ctx.restore();
  }

  function colorOf(a, c) {
    if (a.main) return patterns.main;
    if (a.past) return patterns.past;
    if (mode !== "canon") return patterns.fork;
    if (a.state === "green") return patterns.held;
    if (a.state === "red") return patterns.broke;
    if (a.state === "behind") return patterns.pending;
    return patterns.fork;
  }

  function draw() {
    const c = palette();
    ctx.clearRect(0, 0, W, H);
    drawSky(c);
    drawGround(c);
    const order = [...herd].sort((p, q) => p.lane - q.lane || p.x - q.x);
    for (const a of order) {
      drawAnimal(a, colorOf(a, c), a.past && !a.main ? 0.75 : 1);
      if (a.main && me?.a === a && !me.jump) {
        const s = scales[a.lane];
        const bob = Math.sin((clock * 12 + a.seed) * 2) * 1.6 * s;
        const buckle = me.ride / RIDE;
        const shake = buckle > 0.7 ? Math.sin(clock * 40) * (buckle - 0.7) * 0.6 : 0;
        drawRider(a.x - 2 * s, lanes[a.lane] - 36 * s + bob, s, c.ink, shake);
        if (playing) {
          // How long until this ride bucks you off.
          ctx.lineWidth = 3;
          ctx.strokeStyle = buckle > 0.7 ? c.broke : c.pending;
          ctx.globalAlpha = 0.9;
          ctx.beginPath();
          ctx.arc(a.x - 2 * s, lanes[a.lane] - 80 * s, 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - buckle));
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        if (a.fresh > 0) {
          ctx.strokeStyle = c.main;
          ctx.globalAlpha = a.fresh;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(a.x, lanes[a.lane] - 26 * s, 50 * (1.4 - a.fresh * 0.4) * s, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
    // Labels: PR numbers and reviews in Git; reasons for red in Canon.
    const font = `500 ${small ? 10 : 11}px "Martian Mono", ui-monospace, monospace`;
    for (const a of herd) {
      if (a.main || a.past) continue;
      const p = top(a);
      if (mode === "git") {
        if (a.reviewed) label(a.reviewed === "ok" ? `#${a.id} ✓ reviewed` : `#${a.id} ✗ broken`, p.x, p.y - 4, a.reviewed === "ok" ? c.held : c.broke, 1, font);
        else label(`#${a.id}`, p.x, p.y - 4, c.muted, 0.85, font);
      } else if (mode === "canon" && a.state === "red") {
        label(a.against ? `✗ contradicts “${a.against}”` : `✗ ${a.reason}`, p.x, p.y - 4, c.broke, 1, font, small ? 150 : 230);
      }
    }
    // Two green changes that can't both be true: a red dashed tether between them.
    if (mode === "canon") {
      const seen = new Set();
      for (const a of herd) {
        if (a.pair == null || seen.has(a.pair) || a.state !== "green" || a.past) continue;
        const b = herd.find((o) => o !== a && o.pair === a.pair && o.state === "green" && !o.past);
        if (!b) continue;
        seen.add(a.pair);
        const p = center(a), q = center(b);
        ctx.setLineDash([4, 5]);
        ctx.lineDashOffset = -clock * 10;
        ctx.strokeStyle = c.broke;
        ctx.lineWidth = 1.4;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        label("can't both be true", (p.x + q.x) / 2, (p.y + q.y) / 2, c.broke, 0.95, font);
        tip("Those two can't both be true. Land on one and watch the other.", "pair");
      }
    }
    // Review ring (Git).
    if (press && mode === "git") {
      const p = center(press.a), s = scales[press.a.lane];
      ctx.strokeStyle = c.pending;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 40 * s, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, press.st / REVIEW));
      ctx.stroke();
      if (!press.done) label("reviewing…", p.x, p.y - 56 * s, c.ink, 0.9, font);
    }
    // Jumping: the lasso rope and the rider in the air.
    if (me?.jump) {
      const j = me.jump, t = j.target, s = scales[t.lane];
      const to = { x: t.x - 2 * s, y: lanes[t.lane] - 36 * s };
      const u = Math.min(1, j.st / JUMP);
      const ctrl = { x: (j.from.x + to.x) / 2, y: Math.min(j.from.y, to.y) - 70 };
      const p = quad(j.from, ctrl, to, ease(u));
      ctx.strokeStyle = j.auto ? c.pending : c.ink;
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 10 * s);
      ctx.quadraticCurveTo((p.x + to.x) / 2, (p.y + to.y) / 2 + 20, to.x, to.y - 6 * s);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(to.x, to.y - 2 * s, 16 * s, 9 * s, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      drawRider(p.x, p.y, s, c.ink, -0.3 + u * 0.3);
    }
    // Down: bucked off or rolling back.
    if (me?.down) {
      const d = me.down, u = Math.min(1, d.st / 0.5);
      drawRider(me.pos.x - u * 30, me.pos.y + u * 34, 0.9, c.ink, u * 1.6);
      label(d.why, me.pos.x + 40, me.pos.y - 30, me.down.dur === ROLLBACK ? c.broke : c.muted, 1, font);
    }
    for (const f of floaters) {
      const age = clock - f.born;
      const color = f.tone === "broke" ? c.broke : f.tone === "held" ? c.held : f.tone === "muted" ? c.muted : c.ink;
      label(f.text, f.x, f.y - easeOut(Math.min(1, age / 2.2)) * 26, color, Math.min(1, (2.2 - age) / 0.6), `500 ${small ? 11.5 : 12.5}px Archivo, system-ui, sans-serif`, small ? 260 : 420);
    }
  }

  // ---- Input ----------------------------------------------------------------------------------------
  function hit(e) {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bestD = (e.pointerType === "touch" ? 46 : 36);
    for (const a of herd) {
      if (a.main || a.past) continue;
      const p = center(a);
      const d = Math.hypot((p.x - x) * 0.85, p.y - y) / Math.max(0.8, scales[a.lane]);
      if (d < bestD) {
        best = a;
        bestD = d;
      }
    }
    return best;
  }
  cv.addEventListener("pointerdown", (e) => {
    if (!playing || !me) return;
    const a = hit(e);
    if (!a) return;
    if (mode === "canon") return lasso(a);
    press = { a, st: 0, done: false };
    cv.setPointerCapture?.(e.pointerId);
  });
  const release = () => {
    if (!press) return;
    const p = press;
    press = null;
    if (!playing) return;
    if (!p.done) {
      if (p.st > TAP) git.review += p.st;
      if (p.st <= TAP) lasso(p.a);
    }
  };
  cv.addEventListener("pointerup", release);
  cv.addEventListener("pointercancel", () => { press = null; });

  // ---- Loop -----------------------------------------------------------------------------------------
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    draw();
    requestAnimationFrame(frame);
  }
  addEventListener("resize", resize);
  addEventListener("keydown", (e) => { if (e.key === "Escape") location.href = "/"; });
  resize();
  pool = shuffle(CLAIMS);
  newMain();
  for (let i = 0; i < 6; i++) spawn({ x: rand(PX + 120, W - 40) });
  intro();
  last = performance.now();
  requestAnimationFrame(frame);
})();
