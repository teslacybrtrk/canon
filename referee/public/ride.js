// The rider on the hero's horizon: the cowboy from Canon Stampede galloping in place on main,
// next to the link to the game. Same drawings as stampede.js (horse, rider, hat), in the same scanlines.
// Hovering the link spurs the horse on.
(() => {
  const link = document.querySelector(".ride");
  const canvas = link?.querySelector("canvas");
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;

  const still = matchMedia("(prefers-reduced-motion: reduce)");
  const PALETTE = {
    dark: { horse: "#fff1cc", ink: "#f5efe6", edge: "rgba(1,14,32,0.95)", brand: "#fd6f16", rope: "#fdc86d", shadow: "rgba(0,0,0,0.35)", dust: "rgba(253,200,109,0.45)" },
    light: { horse: "#01132a", ink: "#01132a", edge: "rgba(255,255,255,0.95)", brand: "#ed5616", rope: "#b7791f", shadow: "rgba(1,19,42,0.16)", dust: "rgba(1,19,42,0.22)" },
  };
  const FEET = 15; // px above the bottom of the hero: on the ridge
  let W = 0, H = 0, S = 1, theme = null, fill = null, clock = 0, last = 0, raf = 0, spur = 0, spurTarget = 0, visible = true;
  let dust = [], nextDust = 0;

  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S = (H - FEET - 4) / 86; // hooves to the top of the lasso
  }

  function palette() {
    const t = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    if (t !== theme) {
      theme = t;
      const c = document.createElement("canvas");
      c.width = 4;
      c.height = 4;
      const g = c.getContext("2d");
      g.fillStyle = PALETTE[t].horse;
      g.fillRect(0, 0, 3, 4);
      fill = ctx.createPattern(c, "repeat");
    }
    return PALETTE[t];
  }

  // One leg in two segments that folds as it swings forward.
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

  // The cowboy: leg in the stirrup, orange bandana, one hand on the reins, the other circling the lasso.
  function rider(c, t) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.shadowColor = c.edge;
    ctx.shadowBlur = 3;
    ctx.strokeStyle = c.ink;
    ctx.fillStyle = c.ink;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(5, 8);
    ctx.lineTo(3, 14);
    ctx.stroke();
    ctx.save();
    ctx.rotate(0.1 + Math.sin(t * 18) * 0.03);
    ctx.lineWidth = 7.5;
    ctx.beginPath();
    ctx.moveTo(0, -1);
    ctx.lineTo(1, -14);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(1.5, -19.5, 4.3, 0, Math.PI * 2);
    ctx.fill();
    hat(1.5, -23.5);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#fd6f16";
    ctx.beginPath();
    ctx.moveTo(-2.5, -15.5);
    ctx.lineTo(5.5, -15.5);
    ctx.lineTo(1, -10.5);
    ctx.closePath();
    ctx.fill();
    const spin = t * (8 + spur * 6);
    const hand = { x: 6 + Math.cos(spin) * 1.5, y: -31 };
    ctx.lineWidth = 3;
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
    ctx.restore();
  }

  function draw() {
    const c = palette();
    ctx.clearRect(0, 0, W, H);
    // Origin at the horse's feet, right of centre so the dust has room to trail behind.
    const x0 = W - 52 * S, y0 = H - FEET;
    const ph = clock * (11 + spur * 6);
    const bob = Math.sin(ph * 2) * 1.8, pitch = Math.sin(ph * 2 + 0.6) * 0.04;

    ctx.fillStyle = c.dust;
    for (const d of dust) {
      const age = clock - d.born;
      ctx.globalAlpha = Math.max(0, 1 - age / d.life);
      ctx.fillRect(x0 + (d.x - age * d.v) * S, y0 - (d.y + age * 9) * S, d.s, d.s);
    }
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(x0, y0);
    ctx.scale(S, S);
    ctx.fillStyle = c.shadow;
    ctx.beginPath();
    ctx.ellipse(2, 0.5, 26 - bob, 3.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = fill;
    ctx.strokeStyle = fill;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalAlpha = 0.6;
    leg(18, -25 + bob, ph + 0.5, true);
    leg(-17, -25 + bob, ph + Math.PI + 0.5, false);
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.translate(0, bob);
    ctx.rotate(pitch);
    horse(ph);
    // The saddle blanket: this horse is main.
    ctx.fillStyle = c.brand;
    ctx.beginPath();
    ctx.roundRect(-11, -41, 17, 8, 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = fill;
    leg(15, -25 + bob, ph, true);
    leg(-20, -25 + bob, ph + Math.PI, false);
    ctx.save();
    ctx.translate(-3, -(38 - bob));
    ctx.rotate(pitch);
    ctx.scale(1.2, 1.2);
    rider(c, clock);
    ctx.restore();
    ctx.restore();
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    spur += (spurTarget - spur) * Math.min(1, dt * 4);
    // Hooves kick up dust that blows back behind the horse.
    nextDust -= dt * (1 + spur);
    if (nextDust <= 0) {
      dust.push({ born: clock, life: 0.9, x: -16 + Math.random() * 30, y: Math.random() * 4, v: 50 + Math.random() * 40, s: Math.random() < 0.3 ? 2 : 1.5 });
      nextDust = 0.06;
    }
    dust = dust.filter((d) => clock - d.born < d.life);
    draw();
    raf = requestAnimationFrame(frame);
  }

  function run() {
    cancelAnimationFrame(raf);
    raf = 0;
    if (still.matches) {
      clock = 0.3;
      draw();
    } else if (visible) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  link.addEventListener("pointerenter", () => { spurTarget = 1; });
  link.addEventListener("pointerleave", () => { spurTarget = 0; });
  link.addEventListener("focus", () => { spurTarget = 1; });
  link.addEventListener("blur", () => { spurTarget = 0; });
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; run(); }).observe(link);
  still.addEventListener?.("change", run);
  new MutationObserver(() => { if (!raf) draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  addEventListener("resize", () => { resize(); draw(); });
  resize();
  run();
})();
