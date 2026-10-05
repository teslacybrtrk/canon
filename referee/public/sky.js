// The hero sky. The sun is canon. Worlds fork from it as dashed branches, wait while every fact
// is checked, then either merge back into the sun (it flares) or turn red and fall behind the ridge.
// Drawn in vertical scanlines, like a halftone print. Click the sun to fork a world yourself.
(() => {
  const hero = document.querySelector(".hero");
  const canvas = document.getElementById("sky");
  const ctx = canvas?.getContext("2d");
  if (!hero || !ctx) return;
  hero.classList.add("sky-live");

  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const PALETTE = {
    dark: { fork: "#fd8a2c", held: "#4cc38a", broke: "#ff6b86", pending: "#fdc86d", node: "#fff3dc", ember: "#fdc86d", glow: 0.42, trail: 0.6 },
    light: { fork: "#ed5616", held: "#1e7b4f", broke: "#c0264e", pending: "#b7791f", node: "#ffffff", ember: "#ed5616", glow: 0.3, trail: 0.7 },
  };
  const OUT = 1.7, HOLD = 0.55, BACK = 1.5, FADE = 1.2, FALL = 1.5;

  let W = 0, H = 0, R = 250, VIS = 130, small = false;
  let stars = [], embers = [], worlds = [], rings = [];
  let px = 0, pxTarget = 0, flare = 0, nextFork = 2.2, last = 0, clock = 0, raf = 0;

  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
  const easeIn = (x) => x * x * x;
  const easeOut = (x) => 1 - (1 - x) ** 3;
  const rand = (a, b) => a + Math.random() * (b - a);
  const quad = (a, c, b, t) => ({ x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c.x + t * t * b.x, y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c.y + t * t * b.y });

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

  // The sun's centre: it rises on load, drifts a little with the pointer and sinks as the page scrolls.
  function sun() {
    const rise = (1 - Math.min(1, clock / 1.8)) ** 3 * 160;
    const sink = Math.min(scrollY, H) * 0.22;
    return { x: W / 2 + px * 14, y: H - VIS + R + rise + sink };
  }
  const rim = (s, phi) => ({ x: s.x + R * Math.sin(phi), y: s.y - R * Math.cos(phi) });

  function fork(fate, side, byHand = false) {
    // As many worlds in flight as the sky beside the sun has room for; a click may add a few more.
    const room = small ? 3 : Math.max(3, Math.min(7, Math.floor((W - R * 2.2) / 70)));
    if (worlds.length >= room + (byHand ? 3 : 0)) return;
    side ??= Math.random() < 0.5 ? -1 : 1;
    fate ??= Math.random() < 0.58 ? "merge" : "reject";
    let hover;
    for (let i = 0; i < 8; i++) {
      hover = small
        ? { dx: side * rand(R * 0.45, Math.min(W / 2 - 16, R * 0.95)), y: H - rand(118, 158) }
        : { dx: side * rand(R * 1.12, Math.min(W / 2 - 40, R + 500)), y: H - rand(68, 145) };
      if (worlds.every((w) => Math.hypot(w.hover.dx - hover.dx, w.hover.y - hover.y) > 46)) break;
    }
    worlds.push({
      born: clock, side, fate, hover,
      phiOut: side * rand(0.12, 0.62), phiBack: side * rand(0.02, 0.4),
      lift: small ? rand(15, 45) : rand(25, 65), liftBack: small ? rand(20, 50) : rand(30, 80),
      check: rand(1.5, 3.2), seed: rand(0, 6.3), parts: null, merged: null,
    });
  }

  // Where a world is at time ts, and the two branches (out, back) as point lists for the dashed trail.
  function place(w, s, ts) {
    const p0 = rim(s, w.phiOut);
    const p1 = { x: s.x + w.hover.dx, y: w.hover.y };
    // Control points stay below the call-to-action, so branches never cross the buttons.
    const ceiling = H - (small ? 190 : 215);
    const c1 = { x: p0.x + (p1.x - p0.x) * 0.3, y: Math.max(ceiling, Math.min(p0.y, p1.y) - w.lift) };
    const out = (u) => { const pts = []; for (let i = 0; i <= 28; i++) pts.push(quad(p0, c1, p1, (i / 28) * u)); return pts; };
    const judged = OUT + w.check;
    if (ts < OUT) {
      const u = ease(ts / OUT);
      return { pos: quad(p0, c1, p1, u), out: out(u), base: p0, state: "out" };
    }
    const bob = Math.sin(clock * 2.4 + w.seed) * 1.6;
    if (ts < judged) return { pos: { x: p1.x, y: p1.y + bob }, out: out(1), base: p0, state: "check" };
    if (ts < judged + HOLD) return { pos: { x: p1.x, y: p1.y + bob }, out: out(1), base: p0, state: w.fate, u: (ts - judged) / HOLD };
    if (w.fate === "merge") {
      const p2 = rim(s, w.phiBack);
      const c2 = { x: p1.x + (p2.x - p1.x) * 0.7, y: Math.max(ceiling, Math.min(p1.y, p2.y) - w.liftBack) };
      const u = Math.min(1, (ts - judged - HOLD) / BACK);
      const back = [];
      for (let i = 0; i <= 28; i++) back.push(quad(p1, c2, p2, (i / 28) * easeIn(u)));
      return { pos: u < 1 ? quad(p1, c2, p2, easeIn(u)) : null, out: out(1), back, base: p0, state: "back", u };
    }
    return { pos: null, out: out(1), base: p0, state: "fall", u: (ts - judged - HOLD) / FALL, at: p1 };
  }

  function stroke(pts, color, alpha) {
    if (pts.length < 2) return;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  // A world is a small square in the same scanlines as the sun.
  function block(x, y, size, color, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    const bar = (size * 3) / 11, step = (size * 4) / 11;
    for (let i = 0; i < 3; i++) ctx.fillRect(x - size / 2 + i * step, y - size / 2, bar, size);
  }

  function drawSun(s, c, t) {
    const g = ctx.createRadialGradient(s.x, H, R * 0.3, s.x, H, R * 2.4);
    const a = c.glow * (1 + 0.1 * Math.sin(t * 0.8) + flare * 0.7);
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
      ctx.globalAlpha = Math.min(1, 0.84 + flare * 0.2 + 0.16 * Math.sin(t * 1.7 + x * 0.045) * Math.sin(t * 0.45 + x * 0.012));
      ctx.fillRect(x, top, bar, Math.min(H, s.y + h) - top);
    }

    // Heat bands rise through the sun and thin out as they climb, like the streaks on the icon.
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

  function draw(t) {
    const c = PALETTE[document.documentElement.dataset.theme === "light" ? "light" : "dark"];
    const s = sun();
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);

    if (c === PALETTE.dark) {
      ctx.fillStyle = "#f5efe6";
      for (const st of stars) {
        ctx.globalAlpha = 0.1 + 0.4 * (0.5 + 0.5 * Math.sin(t * st.sp + st.ph));
        ctx.fillRect(st.x - px * 6, st.y, st.s, st.s);
      }
    }

    // Branches first, so they emerge from behind the disc.
    const placed = worlds.map((w) => [w, place(w, s, clock - w.born)]);
    ctx.lineWidth = 1.3;
    ctx.setLineDash([3, 4]);
    ctx.lineDashOffset = -t * 14;
    for (const [w, p] of placed) {
      const fade = w.merged != null ? Math.max(0, 1 - (clock - w.merged) / FADE) : p.state === "fall" ? Math.max(0, 1 - p.u * 1.4) : 1;
      const color = p.state === "out" || p.state === "check" ? c.fork : p.state === "reject" || p.state === "fall" ? c.broke : c.held;
      stroke(p.out, color, c.trail * fade);
      if (p.back) stroke(p.back, color, c.trail * fade);
    }
    ctx.setLineDash([]);

    drawSun(s, c, t);

    for (const [w, p] of placed) {
      const fade = w.merged != null ? Math.max(0, 1 - (clock - w.merged) / FADE) : p.state === "fall" ? Math.max(0, 1 - p.u * 1.4) : 1;
      ctx.globalAlpha = fade;
      ctx.fillStyle = c.node;
      ctx.beginPath();
      ctx.arc(p.base.x, p.base.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const r of rings) {
      const u = (clock - r.at) / 1.4;
      ctx.globalAlpha = 0.6 * (1 - u);
      ctx.strokeStyle = c.pending;
      ctx.lineWidth = 2.2 * (1 - u) + 0.4;
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
    for (const [w, p] of placed) {
      if (p.state === "out") block(p.pos.x, p.pos.y, size, c.fork, 1);
      else if (p.state === "check") {
        block(p.pos.x, p.pos.y, size, c.fork, 1);
        ctx.globalAlpha = 0.35 + 0.35 * Math.sin(clock * 6 + w.seed);
        ctx.strokeStyle = c.pending;
        ctx.lineWidth = 1;
        const o = size / 2 + 4;
        ctx.strokeRect(p.pos.x - o, p.pos.y - o, o * 2, o * 2);
        const scan = ((clock * 1.4 + w.seed) % 1) * size;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = c.node;
        ctx.fillRect(p.pos.x - size / 2, p.pos.y - size / 2 + scan, size, 1);
      } else if (p.state === "merge") block(p.pos.x, p.pos.y, size * (1 + 0.25 * Math.sin(Math.PI * p.u)), c.held, 1);
      else if (p.state === "reject") block(p.pos.x + Math.sin(p.u * 60) * 2.2 * (1 - p.u), p.pos.y, size, c.broke, 1);
      else if (p.state === "back" && p.pos) block(p.pos.x, p.pos.y, size * (1 - 0.55 * p.u), p.u > 0.6 ? c.pending : c.held, 1);
      else if (p.state === "fall" && w.parts) {
        for (const f of w.parts) {
          ctx.save();
          ctx.globalAlpha = Math.max(0, 1 - p.u);
          ctx.translate(f.x, f.y);
          ctx.rotate(f.a);
          ctx.fillStyle = c.broke;
          ctx.fillRect(-f.s / 2, -f.s / 2, f.s, f.s);
          ctx.restore();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  function step(dt) {
    clock += dt;
    px += (pxTarget - px) * Math.min(1, dt * 3);
    flare *= Math.exp(-dt * 1.8);
    if (clock > nextFork) {
      fork();
      nextFork = clock + rand(0.9, 1.8);
    }
    const s = sun();
    for (const w of worlds) {
      const p = place(w, s, clock - w.born);
      if (p.state === "back" && p.u >= 1 && w.merged == null) {
        w.merged = clock;
        flare = Math.min(1.4, flare + 1);
        rings.push({ at: clock });
      }
      if (p.state === "fall") {
        if (!w.parts) {
          w.parts = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([i, j]) => ({
            x: p.at.x + i * 3, y: p.at.y + j * 3, s: small ? 4 : 5, a: 0,
            vx: i * rand(10, 40) + w.side * 18, vy: j * 10 - rand(40, 90), va: rand(-6, 6),
          }));
        }
        for (const f of w.parts) {
          f.vy += 420 * dt;
          f.x += f.vx * dt;
          f.y += f.vy * dt;
          f.a += f.va * dt;
        }
      }
    }
    worlds = worlds.filter((w) => {
      const ts = clock - w.born - OUT - w.check - HOLD;
      return w.merged != null ? clock - w.merged < FADE : w.fate === "merge" || ts < FALL;
    });
    rings = rings.filter((r) => clock - r.at < 1.4);
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

  // Reduced motion: the risen sun and the stars, drawn once, redrawn when the size or theme changes.
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
    return Math.hypot(x - s.x, y - s.y) < R && y < H - 30 && !e.target.closest("a, button, .cmd") ? (x < s.x ? -1 : 1) : 0;
  };
  hero.addEventListener("pointermove", (e) => {
    pxTarget = (e.clientX / W - 0.5) * 2;
    hero.style.cursor = !still.matches && onSun(e) ? "pointer" : "";
  });
  hero.addEventListener("pointerleave", () => { pxTarget = 0; hero.style.cursor = ""; });
  hero.addEventListener("click", (e) => {
    const side = onSun(e);
    if (side && raf) fork(undefined, side, true);
  });
})();
