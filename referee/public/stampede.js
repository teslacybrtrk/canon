// Canon Stampede: two 40-second rounds riding a stampede of agents' changes.
// The herd streams past you; you make your way forward by lassoing the changes ahead.
// Round 1 is Git: every change looks the same. Review one first (press and hold) or jump blind.
// Round 2 is Canon: the moon (the referee) checks every change against every fact; only green can land,
// and the autopilot button hands the lasso to the referee.
(() => {
  const cv = document.getElementById("stage");
  const ctx = cv.getContext("2d");
  const ui = document.querySelector(".ui");
  const el = (k) => ui.querySelector(`[data-r="${k}"]`);

  const ROUND = 40, JUMP = 0.42, REVIEW = 1.0, TAP = 0.22, ROLLBACK = 2.6;
  const JUDGE = 0.6, RECHECK = 0.7, BAD = 0.32, SPEED = 260, RIDER = 1.2;
  // How fast the herd runs, picked before round 1 and kept for both rounds so they compare fairly.
  const PACES = { easy: { label: "Easy", x: 0.7 }, medium: { label: "Medium", x: 1 }, hard: { label: "Hard", x: 1.45 } };
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
      panel: "rgba(1,14,32,0.84)", moonLit: "#fbf3e4", moonDim: "#6f7d93", dust: "rgba(253,200,109,0.35)",
      brand: "#fd6f16", rope: "#fdc86d", shadow: "rgba(0,0,0,0.35)", heldRgb: "76,195,138", riderEdge: "rgba(1,14,32,0.95)" },
    light: { skyTop: "#fbf6ef", skyLow: "#fde3c4", glow: "253,143,62", groundTop: "#efd2ad", groundLow: "#e2bb8c", ridge: "#d8ad7f", lines: "rgba(1,19,42,0.10)",
      fork: "#ed5616", held: "#1e7b4f", broke: "#c0264e", pending: "#b7791f", main: "#ffffff", past: "#a08a72", ink: "#01132a", muted: "#5b6577",
      panel: "rgba(255,255,255,0.92)", moonLit: "#2a3a52", moonDim: "#01132a", dust: "rgba(1,19,42,0.18)",
      brand: "#ed5616", rope: "#b7791f", shadow: "rgba(1,19,42,0.14)", heldRgb: "30,123,79", riderEdge: "rgba(255,255,255,0.9)" },
  };

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const shuffle = (list) => list.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
  const easeOut = (x) => 1 - (1 - x) ** 3;
  const quad = (a, c, b, t) => ({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * b.y });

  let W = 0, H = 0, small = false, horizon = 0, PX = 0, yMin = 0, yMax = 0, base = 1, hudBottom = 100;
  let mode = null, playing = false, time = 0, clock = 0, last = 0;
  let herd = [], me = null, floaters = [], dust = [], lines = [], stars = [], ridge = [], scroll = 0;
  let press = null, nextSpawn = 0, nextConflict = 0, nextId = 401, pool = [], pairSeq = 0, landedPairs = new Map(), shown = new Set();
  let git = null, canon = null, theme = null, patterns = {}, moonShown = 0, beams = [], autopilot = false, pace = "medium";
  try { const saved = localStorage.getItem("canon-stampede-pace"); if (PACES[saved]) pace = saved; } catch {}

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
    yMin = horizon + g * 0.2;
    yMax = H - 70; // the autopilot button sits below the herd
    base = small ? 0.72 : Math.min(1.15, Math.max(0.85, W / 1300));
    for (const a of herd) a.y = Math.min(yMax, Math.max(yMin, a.y));
    PX = W * (small ? 0.2 : 0.24);
    stars = Array.from({ length: Math.round((W * horizon) / 7000) }, () => ({ x: rand(0, W), y: rand(0, horizon * 0.85), s: Math.random() < 0.12 ? 2 : 1, ph: rand(0, 6.3) }));
    lines = Array.from({ length: Math.round(W / 40) }, () => ({ x: rand(0, W), y: rand(horizon + 6, H), len: rand(20, 70) }));
    ridge = Array.from({ length: 40 }, (_, i) => ({ x: i / 39, h: rand(6, 22) }));
    el("tip-above").style.top = `${Math.round(horizon - 30)}px`; // just above the ridge
    el("tip-below").style.top = `${Math.round(horizon + 14)}px`;
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
    // Every change enters ahead of you and drifts back past the rider: you push forward through the herd.
    const x = extra.x ?? W + 80;
    const y = extra.y ?? freeY(x);
    if (y == null) return;
    herd.push({
      id: nextId++, kind: Math.random() < 0.35 ? "bull" : "horse", y,
      x, seed: rand(0, 6.3),
      bad: Math.random() < BAD, reason: pick(FACTS), claim: pool.pop() ?? pick(CLAIMS),
      pair: null, side: 0, state: "new", st: 0, reviewed: null, main: false, past: false, ...extra,
    });
  }
  // Depth on the prairie: 0 at the far edge, 1 up close. Size and speed follow it.
  const depth = (y) => Math.min(1, Math.max(0, (y - yMin) / (yMax - yMin)));
  const scaleAt = (y) => base * (0.72 + 0.34 * depth(y));
  const sc = (a) => scaleAt(a.y);
  const speedAt = (y) => -(60 + Math.max(W, 375) * 0.08) * (0.8 + 0.4 * depth(y)) * PACES[pace].x;
  // The space an animal needs so neither bodies nor the labels above them overlap.
  const room = (s) => ({ x: 84 * s + 6, y: 56 * s + 18 });
  // A random depth with room around it at this x, or null when the edge is crowded.
  function freeY(x) {
    for (let i = 0; i < 16; i++) {
      const y = rand(yMin, yMax);
      const clear = herd.every((a) => {
        const r = room(Math.max(sc(a), scaleAt(y)));
        return Math.abs(a.x - x) > r.x + 40 || Math.abs(a.y - y) > r.y;
      });
      if (clear) return y;
    }
    return null;
  }
  const spawnEvery = () => rand(0.55, 0.8) * Math.min(1.8, Math.max(1, 1100 / W)) / PACES[pace].x;

  function spawnConflict() {
    const pair = pairSeq++;
    const [a, b] = CONFLICTS[pair % CONFLICTS.length];
    spawn({ pair, side: 0, claim: a, bad: false, x: W + 80 });
    spawn({ pair, side: 1, claim: b, bad: false, x: W + 150 });
  }
  const partnerLanded = (a) => a.pair != null && landedPairs.has(a.pair) && landedPairs.get(a.pair).side !== a.side;
  const brokenNow = (a) => a.bad || partnerLanded(a);
  const top = (a) => ({ x: a.x, y: a.y - 50 * sc(a) });
  const center = (a) => ({ x: a.x, y: a.y - 26 * sc(a) });

  function newMain() {
    const a = { id: nextId++, kind: "horse", y: freeY(PX) ?? (yMin + yMax) / 2, x: PX, seed: rand(0, 6.3), bad: false, reason: "", claim: "", pair: null, side: 0, state: "green", st: 0, reviewed: null, main: true, past: false, fresh: 0 };
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

  const tipTimers = {};
  // `at` ("above" or "below") shows the tip at the horizon instead of under the HUD; each spot keeps its own tip.
  function tip(text, once, at) {
    if (once) {
      if (shown.has(once)) return;
      shown.add(once);
    }
    const k = at ? `tip-${at}` : "tip", t = el(k);
    t.textContent = text;
    t.classList.add("on");
    clearTimeout(tipTimers[k]);
    tipTimers[k] = setTimeout(() => t.classList.remove("on"), 5200);
  }

  function intro() {
    mode = null;
    hud();
    card(`<p class="kicker">Two rounds · 40 seconds each</p>
      <h3>Round 1: <em>Git</em></h3>
      <p>You're riding main, and you're the only check. Each animal is an agent's change: jump on one to ship it.</p>
      <div class="legend">
        <span><kbd>Tap</kbd><span>Jump on and ship it.</span></span>
        <span><kbd>Hold</kbd><span>Review it first. Takes a second.</span></span>
      </div>
      <p><b>In this herd, 1 in 3 is broken, and they all look the same.</b> Land on one and production breaks.</p>
      <div class="pace" role="radiogroup" aria-label="Speed"><span>Speed</span>${Object.entries(PACES).map(([k, p]) =>
        `<button type="button" role="radio" data-pace="${k}" aria-checked="${k === pace}">${p.label}</button>`).join("")}</div>`,
    [{ label: "Start round 1", primary: true, run: () => begin("git") }]);
    for (const b of el("card").querySelectorAll("[data-pace]")) {
      b.addEventListener("click", () => {
        pace = b.dataset.pace;
        try { localStorage.setItem("canon-stampede-pace", pace); } catch {}
        for (const o of el("card").querySelectorAll("[data-pace]")) o.setAttribute("aria-checked", String(o === b));
      });
    }
  }

  function begin(m) {
    mode = m;
    time = 0;
    playing = true;
    autopilot = false;
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
      git = { shipped: 0, broke: 0, review: 0, stale: 0 };
      tip("Tap an animal to jump on it.\nHold to review it first.", null, "below");
    } else {
      canon = { shipped: 0, auto: 0, rejected: 0 };
      tip("Tap a green one to ship it.", null, "below");
    }
    for (let i = 0; i < 5; i++) spawn({ x: rand(PX + 140, W - 40) });
    hud();
  }

  function finish() {
    playing = false;
    press = null;
    autopilot = false;
    if (mode === "git") {
      card(`<p class="kicker">Round 1 · Git</p>
        <h3>${git.shipped} shipped. <em>${git.broke} broke production.</em></h3>
        <p>You spent <b>${git.review.toFixed(1)} s reviewing</b>, and still couldn't be fast and safe at the same time.
        ${git.stale ? ` ${git.stale === 1 ? "One break was a change you'd reviewed" : `${git.stale} breaks were changes you'd reviewed`}: fine on its own, broken after another merge.` : " And a review can't tell you when two changes that each pass break together."}</p>`,
      [{ label: "Round 2: Canon →", primary: true, run: intro2 }]);
    } else {
      const total = canon.shipped + canon.auto;
      card(`<p class="kicker">Canon Stampede · results · ${PACES[pace].label}</p>
        <h3>Same herd. <em>Two ways to run main.</em></h3>
        <table class="vs">
          <tr><th></th><th>Git</th><th>Canon</th></tr>
          <tr><td>Changes shipped</td><td>${git.shipped}</td><td>${total}${canon.auto ? ` <small>(${canon.auto} by autopilot)</small>` : ""}</td></tr>
          <tr><td>Broke production</td><td class="${git.broke ? "bad" : ""}">${git.broke}</td><td class="good">0</td></tr>
          <tr><td>Seconds spent reviewing</td><td>${git.review.toFixed(1)}</td><td class="good">0</td></tr>
        </table>
        <p>The referee rejected ${canon.rejected} broken change${canon.rejected === 1 ? "" : "s"} before anyone could land on them, and re-checked the herd every time main moved.</p>
        <p><b>Same agents, same herd. Reading every diff made you choose between speed and safety. Canon gave you both.</b></p>
        <p class="fine">Here every broken change breaks a fact. In a real app a fact catches what it asserts, so write facts where a silent break costs most.</p>`,
      [{ label: "Play again", primary: true, run: () => { shown.clear(); intro(); } }, { label: "See how Canon works →", href: "/#how" }]);
    }
    hud();
  }

  function intro2() {
    mode = null;
    hud();
    card(`<p class="kicker">Same herd · 40 seconds</p>
      <h3>Round 2: <em>Canon</em></h3>
      <p>Now the moon is the referee. It checks every change for you.</p>
      <div class="legend">
        <span><i class="g"></i><span><b>Green</b> is safe. Tap to ship it.</span></span>
        <span><i class="r"></i><span><b>Red</b> breaks a fact. You can't land on it.</span></span>
        <span><i class="a"></i><span><b>Amber</b> is being re-checked.</span></span>
      </div>
      <p>Or tap <b>Turn on autopilot</b> and let it ship for you.</p>`,
    [{ label: "Start round 2", primary: true, run: () => begin("canon") }]);
  }

  let lastStats = "", measured = -1;
  function hud() {
    el("round").textContent = mode === "git" ? "Round 1 · Git" : mode === "canon" ? "Round 2 · Canon" : "Canon Stampede";
    el("time").style.width = `${mode ? Math.max(0, 1 - time / ROUND) * 100 : 100}%`;
    const html = mode === "git"
      ? `<span>Shipped <b>${git.shipped}</b></span><span>Broke production <b class="bad">${git.broke}</b></span><span>Reviewing <b>${git.review.toFixed(1)} s</b></span>`
      : mode === "canon"
        ? `<span>Shipped <b class="good">${canon.shipped + canon.auto}</b></span><span>Broke production <b class="good">0</b></span><span>Rejected by the referee <b>${canon.rejected}</b></span>`
        : "";
    if (html !== lastStats) {
      el("stats").innerHTML = html;
      lastStats = html;
    }
    const btn = el("auto");
    const hide = !mode || !playing;
    const text = autopilot ? "Autopilot on · take the reins" : "Turn on autopilot";
    if (btn.hidden !== hide) btn.hidden = hide;
    if (btn.textContent !== text) btn.textContent = text;
    btn.classList.toggle("on", autopilot);
    btn.classList.toggle("git", mode === "git");
    if (clock - measured > 0.5) {
      hudBottom = ui.querySelector(".hud").getBoundingClientRect().bottom;
      measured = clock;
    }
  }

  // ---- Moves ----------------------------------------------------------------------------------------
  const riderAt = () => {
    if (me.a) {
      const s = sc(me.a);
      return { x: me.a.x - 3 * s, y: me.a.y - 38 * s };
    }
    return me.pos;
  };

  // Why the rider can't lasso `t` from here, or null if they can. Autopilot picks by the same rule.
  function outOfReach(t, from) {
    if (t.x < from.x - 10) return "Lasso the ones ahead of you";
    if (t.x - from.x > W * 0.62) return "Too far to lasso";
    return null;
  }

  function lasso(t, auto = false) {
    if (!me.a || me.jump || me.down || t === me.a || t.past) return;
    const from = riderAt(), far = outOfReach(t, from);
    if (far) return float(far, top(t), "muted");
    if (mode === "canon") {
      if (t.state === "red") return float(t.against ? `Refused: contradicts “${t.against}”` : `Refused: breaks “${t.reason}”`, top(t), "broke");
      if (t.state !== "green") return float("Still being checked", top(t), "muted");
    }
    me.jump = { st: 0, from, target: t, auto };
    me.a.main = false;
    me.a.past = true;
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
    me.landedAt = clock;
    puff(t);
  }

  // ---- Simulation -----------------------------------------------------------------------------------
  // Keep the herd from overlapping. When two animals are on a collision course, one steers up or down
  // to clear the other: the one further ahead yields, and everyone gives way to the animal you're
  // riding (or jumping onto), so the herd parts around you.
  function separate(dt) {
    const fixed = (a) => a === me?.a || a === me?.jump?.target;
    const vx = (a) => (a === me?.a ? 0 : speedAt(a.y));
    for (let i = 0; i < herd.length; i++) {
      for (let j = i + 1; j < herd.length; j++) {
        const a = herd[i], b = herd[j];
        const r = room(Math.max(sc(a), sc(b)));
        if (Math.abs(b.y - a.y) >= r.y) continue;
        const dx = b.x - a.x, rel = vx(b) - vx(a);
        const ahead = dx * rel < 0 ? Math.abs(rel) * 0.8 : 0;
        if (Math.abs(dx) > r.x + ahead) continue;
        let m = b, n = a;
        if (fixed(b) || (!fixed(a) && a.x > b.x)) { m = a; n = b; }
        if (fixed(m)) continue;
        const sides = [n.y - r.y, n.y + r.y].filter((y) => y >= yMin && y <= yMax);
        const target = sides.sort((p, q) => Math.abs(p - m.y) - Math.abs(q - m.y))[0] ?? (m.y < n.y ? yMin : yMax);
        m.y += Math.sign(target - m.y) * Math.min(Math.abs(target - m.y), 170 * dt);
      }
    }
    for (const a of herd) if (!fixed(a)) a.y = Math.min(yMax, Math.max(yMin, a.y));
  }

  function step(dt) {
    clock += dt;
    scroll += SPEED * PACES[pace].x * dt;
    if (playing) {
      time += dt;
      nextSpawn -= dt;
      if (nextSpawn <= 0) {
        spawn();
        nextSpawn = spawnEvery();
      }
      if (time >= nextConflict) {
        spawnConflict();
        nextConflict = time + 11;
      }
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
      if (a !== me?.a) a.x += speedAt(a.y) * dt;
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
    separate(dt);
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
        if (playing && autopilot && me.ride > 0.45) {
          // Only green ones clearly ahead; with none in reach yet, keep riding.
          const from = riderAt();
          const next = herd.filter((a) => a.state === "green" && !a.past && a !== me.a && a.x > from.x + 20 && !outOfReach(a, from))
            .sort((p, q) => Math.abs(p.x - from.x - 160) - Math.abs(q.x - from.x - 160))[0];
          if (next) lasso(next, true);
        }
      }
      if (me.a?.fresh) me.a.fresh = Math.max(0, me.a.fresh - dt * 1.5);
    }

    // Reviewing (Git): hold on a change to read it; the herd keeps moving meanwhile.
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
      l.x -= SPEED * PACES[pace].x * (0.6 + (l.y - horizon) / (H - horizon)) * dt;
      if (l.x + l.len < 0) {
        l.x = W + rand(0, 80);
        l.y = rand(horizon + 6, H);
      }
    }
    if (Math.random() < dt * 30) {
      const a = pick(herd);
      if (a) dust.push({ x: a.x - 18 * sc(a), y: a.y - 2, vx: -rand(40, 90), born: clock, s: rand(1.5, 3) * sc(a) });
    }
    for (const d of dust) {
      d.x += d.vx * dt;
      d.y += (d.vy ?? 0) * dt;
    }
    dust = dust.filter((d) => clock - d.born < 0.9);
    if (mode) hud();
  }

  // ---- Drawing --------------------------------------------------------------------------------------
  function puff(a) {
    const s = sc(a);
    for (let i = 0; i < 10; i++) dust.push({ x: a.x + rand(-22, 22) * s, y: a.y - 2, vx: rand(-80, 40), vy: -rand(10, 40), born: clock, s: rand(2, 3.6) * s });
  }

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
      // Below the HUD (and the autopilot button), above the horizon.
      const mr = small ? 16 : 24, mx = W * (small ? 0.84 : 0.86), my = Math.min(horizon - mr * 2.2, Math.max(horizon * 0.42, hudBottom + mr * 2));
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

  // How an animal is moving right now: gallop phase, and the body's rise, fall and pitch.
  const gait = (a) => {
    const ph = clock * (9 + 5 * depth(a.y)) + a.seed;
    return { ph, bob: Math.sin(ph * 2) * 1.8, pitch: Math.sin(ph * 2 + 0.6) * 0.04 };
  };

  // One leg in two segments that folds as it swings forward. Angles from straight down, forward positive.
  function leg(x, y, phase, front) {
    const swing = Math.sin(phase) * 0.62;
    const fold = Math.max(0, Math.cos(phase)) * (front ? 1.15 : 0.7);
    const knee = { x: x + Math.sin(swing) * 11, y: y + Math.cos(swing) * 11 };
    const lower = swing + (front ? -fold : fold);
    ctx.lineWidth = 4.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(knee.x, knee.y);
    ctx.stroke();
    ctx.lineWidth = 3.4;
    ctx.beginPath();
    ctx.moveTo(knee.x, knee.y);
    ctx.lineTo(knee.x + Math.sin(lower) * 12.5, knee.y + Math.cos(lower) * 12.5);
    ctx.stroke();
  }

  function horse(ph) {
    ctx.beginPath();
    ctx.moveTo(22, -24);
    ctx.quadraticCurveTo(0, -17, -20, -22);
    ctx.quadraticCurveTo(-30, -26, -27, -34);
    ctx.quadraticCurveTo(-20, -40, -2, -37);
    ctx.quadraticCurveTo(10, -36, 16, -40);
    ctx.quadraticCurveTo(22, -50, 28, -54);
    ctx.lineTo(31, -56);
    ctx.lineTo(32.5, -61);
    ctx.lineTo(35, -55.5);
    ctx.quadraticCurveTo(41, -51, 44, -45);
    ctx.quadraticCurveTo(44.5, -41, 40, -40.5);
    ctx.quadraticCurveTo(34, -41, 30, -37);
    ctx.quadraticCurveTo(26, -29, 22, -24);
    ctx.closePath();
    ctx.fill();
    // Mane and tail stream back in the wind.
    const w = Math.sin(ph * 1.5) * 2.5;
    ctx.lineWidth = 2;
    for (const [x, y] of [[18, -45], [22, -49.5], [26, -53]]) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 7, y - 1 + w * 0.4);
      ctx.stroke();
    }
    ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.moveTo(-26, -34);
    ctx.quadraticCurveTo(-37, -35 + w, -41, -24 + w * 0.6);
    ctx.stroke();
  }

  function bull(ph) {
    ctx.beginPath();
    ctx.moveTo(24, -22);
    ctx.quadraticCurveTo(0, -15, -21, -21);
    ctx.quadraticCurveTo(-30, -25, -28, -33);
    ctx.quadraticCurveTo(-22, -39, -6, -38);
    ctx.quadraticCurveTo(6, -50, 18, -46);
    ctx.quadraticCurveTo(28, -42, 34, -36);
    ctx.quadraticCurveTo(40, -33, 41, -28);
    ctx.quadraticCurveTo(41, -23, 36, -23);
    ctx.quadraticCurveTo(30, -23, 27, -26);
    ctx.quadraticCurveTo(26, -23, 24, -22);
    ctx.closePath();
    ctx.fill();
    // Horns curve up and forward; a thin tail ends in a tuft.
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(33, -36);
    ctx.quadraticCurveTo(37, -44, 44, -43);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(30, -37);
    ctx.quadraticCurveTo(31, -45, 37, -47);
    ctx.stroke();
    const w = Math.sin(ph * 1.5) * 2;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-27, -32);
    ctx.quadraticCurveTo(-35, -30 + w, -36, -21 + w);
    ctx.stroke();
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-36, -21 + w);
    ctx.lineTo(-36.5, -17 + w);
    ctx.stroke();
  }

  // A side-on horse or bull in vertical scanlines, galloping, with its shadow. Origin at its feet.
  function drawAnimal(a, fill, c, alpha = 1) {
    const s = sc(a);
    const { ph, bob, pitch } = gait(a);
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.scale(s, s);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = c.shadow;
    ctx.beginPath();
    ctx.ellipse(2, 0.5, 26 - bob, 3.6, 0, 0, Math.PI * 2);
    ctx.fill();
    // Ready changes glow, so they're easy to spot in the crowd.
    if (mode === "canon" && a.state === "green" && !a.main && !a.past) {
      const g = ctx.createRadialGradient(2, -28, 6, 2, -28, 48);
      g.addColorStop(0, `rgba(${c.heldRgb},0.3)`);
      g.addColorStop(1, `rgba(${c.heldRgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(-48, -76, 100, 92);
    }
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Far legs first, dimmer, for depth; then the body; then the near legs.
    ctx.globalAlpha = alpha * 0.6;
    leg(18, -25 + bob, ph + 0.5, true);
    leg(-17, -25 + bob, ph + Math.PI + 0.5, false);
    ctx.globalAlpha = alpha;
    ctx.save();
    ctx.translate(0, bob);
    ctx.rotate(pitch);
    if (a.kind === "bull") bull(ph);
    else horse(ph);
    if (a.main) {
      // The saddle blanket marks the one you're riding: main.
      ctx.fillStyle = c.brand;
      ctx.beginPath();
      ctx.roundRect(-11, -41, 17, 8, 2);
      ctx.fill();
      ctx.fillStyle = fill;
    }
    ctx.restore();
    leg(15, -25 + bob, ph, true);
    leg(-20, -25 + bob, ph + Math.PI, false);
    ctx.restore();
  }

  // A cowboy hat: curved brim, pinched crown. Origin at the middle of the brim.
  function hat(x, y) {
    ctx.beginPath();
    ctx.ellipse(x, y, 9.5, 2, -0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 5, y);
    ctx.quadraticCurveTo(x - 5.3, y - 5.5, x - 3, y - 6);
    ctx.quadraticCurveTo(x, y - 4.2, x + 3, y - 6);
    ctx.quadraticCurveTo(x + 5.3, y - 5.5, x + 5, y);
    ctx.closePath();
    ctx.fill();
  }

  // You: a cowboy riding main, with an orange bandana and a lasso circling overhead, like the icon.
  // Origin is the saddle. Poses: "ride", "jump" (reaching for the next one) and "fall".
  function drawRider(x, y, s, c, pose = "ride", o = {}) {
    const jump = pose === "jump", fall = pose === "fall";
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(o.tilt ?? 0);
    ctx.scale(s, s * (o.squash ?? 1));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = c.riderEdge;
    ctx.shadowBlur = 3;
    ctx.strokeStyle = c.ink;
    ctx.fillStyle = c.ink;
    // Leg down the horse's flank, boot in the stirrup; tucked up in the air.
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(jump ? 7 : 5, jump ? 4 : 8);
    ctx.lineTo(jump ? 2 : 3, jump ? 9 : 14);
    ctx.stroke();
    ctx.save();
    ctx.rotate(jump ? 0.25 : fall ? -0.3 : 0.1 + Math.sin(clock * 18) * 0.03);
    ctx.lineWidth = 7.5;
    ctx.beginPath();
    ctx.moveTo(0, -1);
    ctx.lineTo(1, -14);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(1.5, -19.5, 4.3, 0, Math.PI * 2);
    ctx.fill();
    if (!o.noHat) hat(1.5, -23.5);
    ctx.shadowBlur = 0;
    ctx.fillStyle = c.brand;
    ctx.beginPath();
    ctx.moveTo(-2.5, -15.5);
    ctx.lineTo(5.5, -15.5);
    ctx.lineTo(1, -10.5);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 3;
    if (jump) {
      // Both arms reaching for the next ride.
      ctx.beginPath();
      ctx.moveTo(1, -13);
      ctx.lineTo(9, -16);
      ctx.lineTo(15, -17);
      ctx.moveTo(1, -12);
      ctx.lineTo(8, -10);
      ctx.lineTo(13, -11);
      ctx.stroke();
    } else if (fall) {
      ctx.beginPath();
      ctx.moveTo(1, -13);
      ctx.lineTo(-6, -20);
      ctx.lineTo(-9, -27);
      ctx.moveTo(1, -12);
      ctx.lineTo(8, -20);
      ctx.lineTo(10, -27);
      ctx.stroke();
    } else {
      // One hand on the reins, the other circling the lasso overhead.
      const spin = clock * 8;
      const hand = { x: 6 + Math.cos(spin) * 1.5, y: -31 };
      ctx.beginPath();
      ctx.moveTo(1, -12);
      ctx.lineTo(7, -8);
      ctx.lineTo(12, -7);
      ctx.moveTo(1, -13);
      ctx.lineTo(6, -22);
      ctx.lineTo(hand.x, hand.y);
      ctx.stroke();
      ctx.strokeStyle = c.rope;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.ellipse(hand.x + Math.cos(spin) * 4, hand.y - 4, 10 + Math.sin(spin) * 2.5, 3, 0.12, 0, Math.PI * 2);
      ctx.stroke();
    }
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
    const order = [...herd].sort((p, q) => p.y - q.y);
    for (const a of order) {
      drawAnimal(a, colorOf(a, c), c, a.past && !a.main ? 0.75 : 1);
      if (a.main && me?.a === a && !me.jump) {
        const s = sc(a);
        const { bob, pitch } = gait(a);
        const since = clock - (me.landedAt ?? -9);
        const squash = since < 0.2 ? 0.84 + 0.16 * (since / 0.2) : 1;
        drawRider(a.x - 3 * s, a.y - (38 - bob) * s, s * RIDER, c, "ride", { squash, tilt: pitch });
        if (a.fresh > 0) {
          ctx.strokeStyle = c.main;
          ctx.globalAlpha = a.fresh;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(a.x, a.y - 26 * s, 50 * (1.4 - a.fresh * 0.4) * s, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
    // Labels: PR numbers and reviews in Git; reasons for red in Canon.
    const font = `500 ${small ? 10 : 11}px "Martian Mono", ui-monospace, monospace`;
    for (const a of herd) {
      if (a.main || a.past || a.x < PX - 30) continue; // behind you: can't be lassoed, so no label
      const p = top(a);
      if (mode === "git") {
        if (a.reviewed) label(a.reviewed === "ok" ? `#${a.id} ✓ reviewed` : `#${a.id} ✗ broken`, p.x, p.y - 4, a.reviewed === "ok" ? c.held : c.broke, 1, font);
        else label(`#${a.id}`, p.x, p.y - 4, c.muted, 0.85, font);
      } else if (mode === "canon" && a.state === "red") {
        label(a.against ? `✗ contradicts “${a.against}”` : `✗ ${a.reason}`, p.x, p.y - 4, c.broke, 1, font, small ? 130 : 190);
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
      const p = center(press.a), s = sc(press.a);
      ctx.strokeStyle = c.pending;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 40 * s, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, press.st / REVIEW));
      ctx.stroke();
      if (!press.done) label("reviewing…", p.x, p.y - 56 * s, c.ink, 0.9, font);
    }
    // Jumping: the lasso rope and the rider in the air.
    if (me?.jump) {
      const j = me.jump, t = j.target, s = sc(t);
      const to = { x: t.x - 3 * s, y: t.y - 38 * s };
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
      drawRider(p.x, p.y, s * RIDER, c, "jump", { tilt: -0.2 + u * 0.2 });
    }
    // Down: rolling back a broken production.
    if (me?.down) {
      const d = me.down, u = Math.min(1, d.st / 0.5);
      drawRider(me.pos.x - u * 30, me.pos.y + u * 34, 0.9, c, "fall", { tilt: u * 1.6, noHat: true });
      // The hat flies off.
      ctx.save();
      ctx.translate(me.pos.x + 26 * d.st, me.pos.y - 40 * d.st + 70 * d.st * d.st);
      ctx.rotate(d.st * 5);
      ctx.scale(0.9, 0.9);
      ctx.fillStyle = c.ink;
      hat(0, 0);
      ctx.restore();
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
      const d = Math.hypot((p.x - x) * 0.85, p.y - y) / Math.max(0.8, sc(a));
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
  el("auto").addEventListener("click", () => {
    if (!playing) return;
    if (mode === "git") return tip("In this round nothing checks a change but you, so nothing can land changes for you.\nSomeone has to read every diff.", null, "above");
    autopilot = !autopilot;
    if (autopilot) tip("Autopilot on: with one line in canon.json, the referee lands every green change by itself.\nPeople decide the facts; agents do the rest.", null, "above");
    hud();
  });
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
