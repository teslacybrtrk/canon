// Canon Stampede's music: an original 8-bit western loop, synthesised with Web Audio (no files).
// A square-wave lead, a galloping triangle bass, and noise for hooves and hats. Browsers only allow
// sound after a click, so the game calls start() from one; the choice is remembered per browser.
(() => {
  const BPM = 150;
  const STEP = 60 / BPM / 4; // one sixteenth
  // The lead, one bar per string: eight eighth notes, "-" holds the note before, "." rests.
  const LEAD = [
    "A4 - E4 A4 B4 C5 B4 A4", "E5 - - - D5 - C5 B4", "D5 - B4 G4 A4 B4 A4 G4", "A4 - - - . . E4 G4",
    "A4 - C5 A4 F5 - E5 D5", "D5 - B4 D5 G5 - F5 E5", "E5 - G#4 B4 E5 - D5 C5", "B4 - - - G#4 - - .",
    "A5 - - - E5 - A5 -", "G5 - E5 C5 E5 - G5 -", "G5 - D5 B4 D5 - F5 E5", "E5 - - - . . C5 D5",
    "C5 - A4 C5 F5 - E5 D5", "E5 - B4 G#4 B4 - D5 C5", "C5 B4 A4 G#4 A4 - E4 -", "A4 - - - . . . .",
  ];
  const ROOTS = ["A2", "A2", "G2", "A2", "F2", "G2", "E2", "E2", "A2", "C3", "G2", "A2", "F2", "E2", "A2", "A2"];
  const BARS = LEAD.length;

  const freq = (note) => {
    const m = /^([A-G])(#?)(\d)$/.exec(note);
    const semis = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] ? 1 : 0);
    return 440 * 2 ** ((semis - 9) / 12 + Number(m[3]) - 4);
  };
  // Lead notes keyed by sixteenth: { f, len } in sixteenths.
  const lead = new Map();
  LEAD.forEach((bar, b) => {
    const t = bar.split(" ");
    t.forEach((n, i) => {
      if (n === "-" || n === ".") return;
      let len = 1;
      while (t[i + len] === "-") len++;
      lead.set(b * 16 + i * 2, { f: freq(n), len: len * 2 });
    });
  });

  let on = true;
  try { on = localStorage.getItem("canon-stampede-music") !== "off"; } catch {}
  let ctx = null, master = null, noise = null, timer = 0, nextAt = 0, pos = 0, playing = false;

  function setup() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  function tone(type, f, t, dur, vol) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.006);
    g.gain.linearRampToValueAtTime(vol * 0.6, t + 0.08);
    g.gain.linearRampToValueAtTime(0, t + dur * 0.92);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur);
  }

  function hit(filter, hz, t, dur, vol) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noise;
    f.type = filter;
    f.frequency.value = hz;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(master);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur);
  }

  function clop(t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.1);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.12);
  }

  function play(p, t) {
    const bar = Math.floor(p / 16), s = p % 16;
    const note = lead.get(p);
    if (note) tone("square", note.f, t, note.len * STEP, 0.16);
    // The gallop: long-short-short on every beat, root on beats 1 and 3, fifth on 2 and 4.
    if (s % 4 !== 1) {
      const root = freq(ROOTS[bar]) * (s % 8 < 4 ? 1 : 1.5);
      tone("triangle", root, t, (s % 4 === 0 ? 2 : 1) * STEP, 0.42);
    }
    if (s % 8 === 0) clop(t);
    if (s % 4 === 2) hit("highpass", 7000, t, 0.04, 0.12);
    if (s === 4 || s === 12) hit("bandpass", 1800, t, 0.12, 0.22);
  }

  function tick() {
    while (nextAt < ctx.currentTime + 0.12) {
      play(pos, nextAt);
      pos = (pos + 1) % (BARS * 16);
      nextAt += STEP;
    }
  }

  function begin() {
    if (playing) return;
    if (!ctx) setup();
    ctx.resume();
    playing = true;
    pos = 0;
    nextAt = ctx.currentTime + 0.05;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(0, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 0.8);
    timer = setInterval(tick, 25);
    tick();
  }

  function end() {
    if (!playing) return;
    playing = false;
    clearInterval(timer);
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
  }

  // A hidden tab goes quiet, and picks up again when it's back.
  document.addEventListener("visibilitychange", () => {
    if (!ctx || !playing) return;
    if (document.hidden) ctx.suspend();
    else ctx.resume();
  });

  window.stampedeMusic = {
    get on() { return on; },
    // Call from a click: starts the loop if music is on.
    start() { if (on) begin(); },
    set(value) {
      on = value;
      try { localStorage.setItem("canon-stampede-music", on ? "on" : "off"); } catch {}
      if (on) begin();
      else end();
    },
  };
})();
