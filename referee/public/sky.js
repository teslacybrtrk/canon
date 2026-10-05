// The hero sky. The sun is canon; the moon is the referee. Worlds fork from the sun, fly to the
// moon and orbit it while every fact is checked. A world that breaks a fact turns red, drops away
// and bursts; one that keeps them all flies home and merges into the sun (it glows a little brighter).
// Drawn in vertical scanlines, like a halftone print. Click the sun to fork a world yourself.
(() => {
  const hero = document.querySelector(".hero");
  const canvas = document.getElementById("sky");
  const ctx = canvas?.getContext("2d");
  if (!hero || !ctx) return;
  hero.classList.add("sky-live");

  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const PALETTE = {
    dark: { fork: "#fd8a2c", held: "#4cc38a", broke: "#ff6b86", pending: "#fdc86d", node: "#fff3dc", ember: "#fdc86d", glow: 0.42, trail: 0.6,
      moonLit: "#fbf3e4", moonDim: "#6f7d93", moonGlow: "205,218,238", scan: "#ffffff" },
    light: { fork: "#ed5616", held: "#1e7b4f", broke: "#c0264e", pending: "#b7791f", node: "#ffffff", ember: "#ed5616", glow: 0.3, trail: 0.7,
      moonLit: "#2a3a52", moonDim: "#01132a", moonGlow: "1,19,42", scan: "#fdc86d" },
  };
  const FLY = 2.6, HOLD = 0.8, BACK = 2.4, FADE = 1.4, DROP = 1.1, POP = 1.0, OMEGA = 1.3, GRAVITY = 110, SWELL = 2.2;

  let W = 0, H = 0, R = 250, VIS = 130, small = false;
  let stars = [], embers = [], worlds = [], rings = [], moonRings = [];
  let px = 0, pxTarget = 0, flare = 0, swells = [], nextFork = 2.2, last = 0, clock = 0, raf = 0;

  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
  const easeIn = (x) => x * x * x;
  const easeOut = (x) => 1 - (1 - x) ** 3;
  const rand = (a, b) => a + Math.random() * (b - a);
  const quad = (a, c, b, t) => ({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * b.y });
  const curve = (a, c, b, u) => { const pts = []; for (let i = 0; i <= 28; i++) pts.push(quad(a, c, b, (i / 28) * u)); return pts; };

  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    W = hero.clientWidth;
    H = hero.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    small = W < 620;
    R = small ? 190 : 250;
    VIS = small ? 112 : 130;
    stars = Array.from({ length: Math.round((W * H) / 9000) }, () => ({
      x: Math.random() * W, y: Math.random() * H * 0.7, s: Math.random() < 0.12 ? 2 : 1, ph: rand(0, 6.3), sp: rand(0.4, 1.6),
    }));
  }

  function sun() {
    const rise = (1 - Math.min(1, clock / 1.8)) ** 3 * 160;
    const sink = Math.min(scrollY, H) * 0.22;
    return { x: W / 2 + px * 14, y: H - VIS + R + rise + sink };
  }
  // The moon sits right of the sun, clear of the buttons; it drifts less than the sun (it's further away).
  function moon() {
    const fade = Math.min(1, Math.max(0, (clock - 0.6) / 1.2));
    if (small) return { x: W - 58, y: H - 138, r: 15, fade };
    const wide = W >= 1100;
    return { x: W / 2 + R + (W / 2 - R) * 0.55 - px * 6, y: H - (wide ? 205 : 140), r: wide ? 26 : 21, fade };
  }
  const rim = (s, phi) => ({ x: s.x + R * Math.sin(phi), y: s.y - R * Math.cos(phi) });
  // Orbits are tilted ellipses: the far half passes behind the moon.
  const orbit = (m, w, a) => {
    const rr = m.r + (small ? 10 : 14) + w.slot * (small ? 6 : 8);
    return { x: m.x + Math.cos(a) * rr, y: m.y + Math.sin(a) * rr * 0.38, front: Math.sin(a) >= 0 };
  };

  function fork(fate, byHand = false) {
    const room = small ? 2 : 4;
    const busy = new Set(worlds.filter((w) => !w.left).map((w) => w.slot));
    if (busy.size >= room + (byHand ? 1 : 0)) return;
    let slot = 0;
    while (busy.has(slot)) slot++;
    worlds.push({
      born: clock, slot, fate: fate ?? (Math.random() < 0.58 ? "merge" : "reject"),
      phiOut: rand(0.1, 0.65), phiBack: rand(-0.35, 0.45), a0: Math.PI + rand(-0.35, 0.25),
      lift: small ? rand(20, 50) : rand(40, 90), liftBack: small ? rand(25, 55) : rand(50, 100),
      check: rand(2.6, 4.2), drift: rand(-14, 22), seed: rand(0, 6.3), parts: null, left: false, merged: null,
    });
  }

  function place(w, s, m, ts) {
    const p0 = rim(s, w.phiOut);
    const entry = orbit(m, w, w.a0);
    const ceiling = H - (small ? 190 : 235);
    const c1 = { x: p0.x + (entry.x - p0.x) * 0.45, y: Math.max(ceiling, Math.min(p0.y, entry.y) - w.lift) };
    if (ts < FLY) {
      const u = ease(ts / FLY);
      return { state: "fly", pos: quad(p0, c1, entry, u), front: true, out: curve(p0, c1, entry, u), base: p0, faded: 0 };
    }
    const at = (tt) => orbit(m, w, w.a0 + OMEGA * (tt - FLY));
    const judged = FLY + w.check;
    const out = curve(p0, c1, entry, 1);
    if (ts < judged + HOLD) {
      const o = at(ts);
      const state = ts < judged ? "check" : w.fate === "merge" ? "pass" : "fail";
      return { state, pos: o, front: o.front, out, base: p0, u: (ts - judged) / HOLD, faded: 0 };
    }
    const leave = at(judged + HOLD);
    const since = ts - judged - HOLD;
    if (w.fate === "reject") {
      // A failed world drops out of orbit first, so the burst happens clear of the moon.
      const fall = (tt) => ({ x: leave.x + w.drift * tt, y: leave.y + 0.5 * GRAVITY * tt * tt });
      if (since < DROP) return { state: "drop", pos: fall(since), front: true, out, base: p0, u: since / DROP, faded: since / FADE };
      return { state: "pop", pos: fall(DROP), front: true, out, base: p0, u: (since - DROP) / POP, faded: since / FADE };
    }
    const p2 = rim(s, w.phiBack);
    const c2 = { x: leave.x + (p2.x - leave.x) * 0.5, y: Math.max(ceiling, Math.min(leave.y, p2.y) - w.liftBack) };
    const u = Math.min(1, since / BACK);
    return { state: "home", pos: u < 1 ? quad(leave, c2, p2, easeIn(u)) : null, front: true, out, back: curve(leave, c2, p2, easeIn(u)), base: p0, u, faded: since / FADE };
  }

  function stroke(pts, color, alpha) {
    if (pts.length < 2 || alpha <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  function block(x, y, size, color, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    const bar = (size * 3) / 11, step = (size * 4) / 11;
    for (let i = 0; i < 3; i++) ctx.fillRect(x - size / 2 + i * step, y - size / 2, bar, size);
  }

  function drawSun(s, c, t) {
    const g = ctx.createRadialGradient(s.x, H, R * 0.3, s.x, H, R * 2.4);
    const a = c.glow * (1 + 0.1 * Math.sin(t * 0.8) + flare * 0.5);
    g.addColorStop(0, `rgba(253,111,22,${a})`);
    g.addColorStop(1, "rgba(253,111,22,0)");
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const body = ctx.createRadialGradient(s.x, H - 8, 0, s.x, H - 8, R * 1.08);
    body.addColorStop(0, "#fff1cc");
    body.addColorStop(0.16, "#fdc86d");
    body.addColorStop(0.48, "#fd8a2c");
    body.addColorStop(0.82, "#f2621a");
    body.addColorStop(1, "#dc4a12");
    ctx.fillStyle = body;
    const pitch = 4, bar = 3;
    for (let x = Math.floor((s.x - R) / pitch) * pitch; x < s.x + R; x += pitch) {
      const dx = x + bar / 2 - s.x;
      const h = Math.sqrt(Math.max(0, R * R - dx * dx));
      const top = s.y - h;
      if (top >= H || h === 0) continue;
      ctx.globalAlpha = Math.min(1, 0.84 + flare * 0.15 + 0.16 * Math.sin(t * 1.7 + x * 0.045) * Math.sin(t * 0.45 + x * 0.012));
      ctx.fillRect(x, top, bar, Math.min(H, s.y + h) - top);
    }
    ctx.globalCompositeOperation = "destination-out";
    const floor = H - 40, ceil = s.y - R;
    for (let i = 0; i < 4; i++) {
      const p = (t * 0.075 + i / 4) % 1;
      const y = floor - p * (floor - ceil);
      const half = Math.sqrt(Math.max(0, R * R - (y - s.y) ** 2));
      ctx.globalAlpha = 0.85 * (1 - p);
      ctx.fillRect(s.x - half, y, half * 2, 3.5 * (1 - p) + 0.5);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // The moon: the same scanlines, lit from the sun's side. A scan line sweeps it while it judges.
  function drawMoon(m, c, t, judging) {
    const glowR = m.r * 3.4;
    const g = ctx.createRadialGradient(m.x, m.y, m.r * 0.8, m.x, m.y, glowR);
    g.addColorStop(0, `rgba(${c.moonGlow},${(0.16 + (judging ? 0.1 : 0)) * m.fade})`);
    g.addColorStop(1, `rgba(${c.moonGlow},0)`);
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(m.x - glowR, m.y - glowR, glowR * 2, glowR * 2);

    const body = ctx.createLinearGradient(m.x - m.r, m.y - m.r * 0.6, m.x + m.r, m.y + m.r * 0.6);
    body.addColorStop(0.15, c.moonLit);
    body.addColorStop(1, c.moonDim);
    ctx.fillStyle = body;
    ctx.globalAlpha = m.fade;
    for (let x = Math.floor((m.x - m.r) / 3) * 3; x < m.x + m.r; x += 3) {
      const dx = x + 1 - m.x;
      const h = Math.sqrt(Math.max(0, m.r * m.r - dx * dx));
      if (h > 0) ctx.fillRect(x, m.y - h, 2, h * 2);
    }
    if (judging) {
      const y = m.y - m.r + ((t * 0.6) % 1) * m.r * 2;
      const half = Math.sqrt(Math.max(0, m.r * m.r - (y - m.y) ** 2));
      ctx.globalAlpha = 0.85 * m.fade;
      ctx.fillStyle = c.scan;
      ctx.fillRect(m.x - half, y, half * 2, 1.2);
    }
  }

  function drawWorld(w, p, c, size) {
    if (!p.pos) return;
    const far = p.front ? 1 : 0.55;
    const sz = size * (p.front ? 1 : 0.8);
    const { x, y } = p.pos;
    if (p.state === "fly") block(x, y, sz, c.fork, 1);
    else if (p.state === "check") {
      block(x, y, sz, c.fork, far);
      if (p.front) {
        ctx.globalAlpha = 0.35 + 0.35 * Math.sin(clock * 4 + w.seed);
        ctx.strokeStyle = c.pending;
        ctx.lineWidth = 1;
        const o = sz / 2 + 3.5;
        ctx.strokeRect(x - o, y - o, o * 2, o * 2);
      }
    } else if (p.state === "pass") block(x, y, sz * (1 + 0.25 * Math.sin(Math.PI * p.u)), c.held, far);
    else if (p.state === "fail") block(x + Math.sin(p.u * 60) * 2 * (1 - p.u), y, sz, c.broke, far);
    else if (p.state === "drop") block(x, y, size, c.broke, 1);
    else if (p.state === "home") block(x, y, size * (1 - 0.55 * p.u), p.u > 0.6 ? c.pending : c.held, 1);
    else if (p.state === "pop" && w.parts) {
      const u = Math.min(1, p.u);
      ctx.globalAlpha = 0.8 * (1 - u);
      ctx.strokeStyle = c.broke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 3 + easeOut(u) * 20, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = c.broke;
      for (const f of w.parts) {
        ctx.globalAlpha = 1 - u;
        const s = 3.2 * (1 - u) + 0.8;
        ctx.fillRect(f.x - s / 2, f.y - s / 2, s, s);
      }
    }
  }

  function draw(t) {
    const c = PALETTE[document.documentElement.dataset.theme === "light" ? "light" : "dark"];
    const s = sun();
    const m = moon();
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);

    if (c === PALETTE.dark) {
      ctx.fillStyle = "#f5efe6";
      for (const st of stars) {
        ctx.globalAlpha = 0.1 + 0.4 * (0.5 + 0.5 * Math.sin(t * st.sp + st.ph));
        ctx.fillRect(st.x - px * 6, st.y, st.s, st.s);
      }
    }

    const placed = worlds.map((w) => [w, place(w, s, m, clock - w.born)]);
    ctx.lineWidth = 1.3;
    ctx.setLineDash([3, 4]);
    ctx.lineDashOffset = -t * 9;
    for (const [w, p] of placed) {
      const color = p.state === "fly" || p.state === "check" ? c.fork : p.state === "fail" || p.state === "drop" || p.state === "pop" ? c.broke : c.held;
      stroke(p.out, color, c.trail * Math.max(0, 1 - p.faded) * (p.state === "check" ? 0.6 : 1));
      if (p.back) stroke(p.back, color, c.trail * (w.merged != null ? Math.max(0, 1 - (clock - w.merged) / FADE) : 1));
    }
    ctx.setLineDash([]);

    drawSun(s, c, t);

    for (const [, p] of placed) {
      ctx.globalAlpha = Math.max(0, 1 - p.faded);
      ctx.fillStyle = c.node;
      ctx.beginPath();
      ctx.arc(p.base.x, p.base.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const r of rings) {
      const u = (clock - r.at) / 1.8;
      ctx.globalAlpha = 0.32 * (1 - u);
      ctx.strokeStyle = c.pending;
      ctx.lineWidth = 1.4 * (1 - u) + 0.4;
      ctx.beginPath();
      ctx.arc(s.x, s.y, R + 6 + easeOut(u) * 90, Math.PI, Math.PI * 2);
      ctx.stroke();
    }
    for (const e of embers) {
      const u = (clock - e.born) / e.life;
      ctx.globalAlpha = 0.65 * Math.sin(Math.PI * u);
      ctx.fillStyle = c.ember;
      ctx.fillRect(s.x + e.dx + Math.sin(clock * e.sway + e.ph) * 6, e.y, e.s, e.s);
    }

    const size = small ? 9 : 11;
    const orbiting = (p) => p.state === "check" || p.state === "pass" || p.state === "fail";
    for (const [w, p] of placed) if (orbiting(p) && !p.front) drawWorld(w, p, c, size);
    drawMoon(m, c, t, placed.some(([, p]) => p.state === "check"));
    for (const r of moonRings) {
      const u = (clock - r.at) / 1.2;
      ctx.globalAlpha = 0.7 * (1 - u);
      ctx.strokeStyle = r.ok ? c.held : c.broke;
      ctx.lineWidth = 1.6 * (1 - u) + 0.4;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r + 3 + easeOut(u) * 16, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const [w, p] of placed) if (!orbiting(p) || p.front) drawWorld(w, p, c, size);
    ctx.globalAlpha = 1;
  }

  function step(dt) {
    clock += dt;
    px += (pxTarget - px) * Math.min(1, dt * 3);
    // A merge swells the sun's glow in and out over two seconds, never a sudden flash.
    swells = swells.filter((at) => clock - at < SWELL);
    flare = Math.min(0.45, swells.reduce((sum, at) => sum + 0.3 * Math.sin((Math.PI * (clock - at)) / SWELL), 0));
    if (clock > nextFork) {
      fork();
      nextFork = clock + rand(1.8, 3.0);
    }
    const s = sun();
    const m = moon();
    for (const w of worlds) {
      const p = place(w, s, m, clock - w.born);
      if ((p.state === "drop" || p.state === "pop" || p.state === "home") && !w.left) {
        w.left = true;
        moonRings.push({ at: clock, ok: w.fate === "merge" });
      }
      if (p.state === "pop" && !w.parts) {
        w.parts = Array.from({ length: 9 }, (_, i) => {
          const a = (i / 9) * Math.PI * 2 + rand(-0.2, 0.2), v = rand(45, 100);
          return { x: p.pos.x, y: p.pos.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v };
        });
      }
      if (p.state === "home" && p.u >= 1 && w.merged == null) {
        w.merged = clock;
        swells.push(clock);
        rings.push({ at: clock });
      }
      for (const f of w.parts ?? []) {
        const drag = Math.exp(-dt * 3.2);
        f.vx *= drag;
        f.vy = f.vy * drag + 60 * dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
      }
    }
    worlds = worlds.filter((w) => {
      const since = clock - w.born - FLY - w.check - HOLD;
      return w.merged != null ? clock - w.merged < FADE : w.fate === "merge" || since < DROP + POP;
    });
    rings = rings.filter((r) => clock - r.at < 1.8);
    moonRings = moonRings.filter((r) => clock - r.at < 1.2);
    embers = embers.filter((e) => clock - e.born < e.life);
    while (embers.length < (small ? 10 : 24)) {
      embers.push({ born: clock - rand(0, 2), life: rand(3.5, 7), dx: rand(-R * 1.5, R * 1.5), y: H - rand(38, 70), vy: rand(8, 22), s: rand(1.5, 2.6), sway: rand(0.6, 1.6), ph: rand(0, 6.3) });
    }
    for (const e of embers) e.y -= e.vy * dt;
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    step(dt);
    draw(clock);
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (raf || still.matches) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  function settle() {
    if (!still.matches) return;
    stop();
    clock = 6;
    worlds = [];
    embers = [];
    draw(clock);
  }

  resize();
  new ResizeObserver(() => { resize(); settle(); }).observe(hero);
  new MutationObserver(settle).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  new IntersectionObserver(([e]) => { if (e.isIntersecting) start(); else stop(); }).observe(hero);
  still.addEventListener("change", () => (still.matches ? settle() : start()));
  settle();

  const onSun = (e) => {
    const r = hero.getBoundingClientRect();
    const s = sun();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return Math.hypot(x - s.x, y - s.y) < R && y < H - 30 && !e.target.closest("a, button, .cmd");
  };
  hero.addEventListener("pointermove", (e) => {
    pxTarget = (e.clientX / W - 0.5) * 2;
    hero.style.cursor = !still.matches && onSun(e) ? "pointer" : "";
  });
  hero.addEventListener("pointerleave", () => { pxTarget = 0; hero.style.cursor = ""; });
  hero.addEventListener("click", (e) => { if (onSun(e) && raf) fork(undefined, true); });
})();
