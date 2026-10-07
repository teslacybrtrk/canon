// Canon Stampede's music: three original western loops, synthesised with Web Audio (no files).
//   Gallop     an 8-bit loop: square-wave lead, galloping triangle bass, noise for hooves and hats.
//   Desperado  spaghetti western: a whistled tune with an echo, a twangy guitar riff, timpani and a whip.
//   Hoedown    bluegrass: banjo rolls, a fiddle tune, boom-chick bass and a washboard.
// Browsers only allow sound after a click, so the game calls start() from one. The choice (a track, or
// off) is remembered per browser.
(() => {
  const freq = (note) => {
    const m = /^([A-G])(#?)(\d)$/.exec(note);
    const semis = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]] + (m[2] ? 1 : 0);
    return 440 * 2 ** ((semis - 9) / 12 + Number(m[3]) - 4);
  };
  // A tune as one bar per string of eight eighth notes: "-" holds the note before, "." rests.
  // Returns notes keyed by sixteenth: { f, len } with len in sixteenths.
  const tune = (bars) => {
    const notes = new Map();
    bars.forEach((bar, b) => {
      const t = bar.split(" ");
      t.forEach((n, i) => {
        if (n === "-" || n === ".") return;
        let len = 1;
        while (t[i + len] === "-") len++;
        notes.set(b * 16 + i * 2, { f: freq(n), len: len * 2 });
      });
    });
    return notes;
  };
  // Chord tones from a name: "Am" -> [root, third, fifth] in octave 3.
  const chord = (name) => {
    const minor = name.endsWith("m");
    const root = freq(`${name.replace("m", "")}3`);
    return [root, root * 2 ** ((minor ? 3 : 4) / 12), root * 2 ** (7 / 12)];
  };

  let ctx = null, master = null, wet = null, noise = null, timer = 0, nextAt = 0, pos = 0, playing = false;

  // ---- Instruments -------------------------------------------------------------------------------------
  function voice({ type = "square", f, t, dur, vol, attack = 0.006, sustain = 0.6, release = 0.06, vib = 0, vibRate = 5.5, lp = 0, send = 0, glide = 0 }) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(glide ? f * glide : f, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(f, t + 0.07);
    if (vib) {
      const l = ctx.createOscillator(), lg = ctx.createGain();
      l.frequency.value = vibRate;
      lg.gain.setValueAtTime(0, t);
      lg.gain.linearRampToValueAtTime(f * vib, t + Math.min(0.35, dur * 0.6));
      l.connect(lg).connect(o.frequency);
      l.start(t);
      l.stop(t + dur + 0.05);
    }
    let out = o;
    if (lp) {
      const fl = ctx.createBiquadFilter();
      fl.type = "lowpass";
      fl.frequency.value = lp;
      out = o.connect(fl);
    }
    const peak = t + attack, hold = Math.max(peak + 0.08, t + dur - release);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, peak);
    g.gain.linearRampToValueAtTime(vol * sustain, peak + 0.08);
    g.gain.setValueAtTime(vol * sustain, hold);
    g.gain.linearRampToValueAtTime(0, t + dur);
    out.connect(g).connect(master);
    if (send) g.connect(gain(send)).connect(wet);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // A plucked string: a bright sawtooth whose filter closes as it decays.
  function pluck(f, t, vol, { bright = 3200, decay = 0.5, send = 0 } = {}) {
    const o = ctx.createOscillator(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = "sawtooth";
    o.frequency.value = f;
    fl.type = "lowpass";
    fl.Q.value = 3;
    fl.frequency.setValueAtTime(bright, t);
    fl.frequency.exponentialRampToValueAtTime(Math.max(220, f * 1.6), t + decay * 0.7);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    o.connect(fl).connect(g).connect(master);
    if (send) g.connect(gain(send)).connect(wet);
    o.start(t);
    o.stop(t + decay + 0.02);
  }

  function hit(filter, hz, t, dur, vol, q = 1) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noise;
    f.type = filter;
    f.frequency.value = hz;
    f.Q.value = q;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(master);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur);
  }

  // A falling sine: a hoof clop when short, a timpani when long.
  function drum(t, from, to, dur, vol) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.8);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur);
  }

  // A whip: a sharp high crack with a short tail into the echo.
  function whip(t) {
    hit("highpass", 3500, t, 0.05, 0.5);
    hit("bandpass", 5200, t + 0.012, 0.09, 0.35, 4);
  }

  function gain(v) {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  }

  // ---- The tracks ------------------------------------------------------------------------------------------
  const GALLOP = (() => {
    const lead = tune([
      "A4 - E4 A4 B4 C5 B4 A4", "E5 - - - D5 - C5 B4", "D5 - B4 G4 A4 B4 A4 G4", "A4 - - - . . E4 G4",
      "A4 - C5 A4 F5 - E5 D5", "D5 - B4 D5 G5 - F5 E5", "E5 - G#4 B4 E5 - D5 C5", "B4 - - - G#4 - - .",
      "A5 - - - E5 - A5 -", "G5 - E5 C5 E5 - G5 -", "G5 - D5 B4 D5 - F5 E5", "E5 - - - . . C5 D5",
      "C5 - A4 C5 F5 - E5 D5", "E5 - B4 G#4 B4 - D5 C5", "C5 B4 A4 G#4 A4 - E4 -", "A4 - - - . . . .",
    ]);
    const roots = ["A2", "A2", "G2", "A2", "F2", "G2", "E2", "E2", "A2", "C3", "G2", "A2", "F2", "E2", "A2", "A2"];
    return {
      id: "gallop", label: "Gallop", bpm: 150, bars: 16, level: 0.5,
      play(p, t, step) {
        const bar = Math.floor(p / 16), s = p % 16;
        const note = lead.get(p);
        if (note) voice({ type: "square", f: note.f, t, dur: note.len * step, vol: 0.16 });
        // The gallop: long-short-short on every beat, root on beats 1 and 3, fifth on 2 and 4.
        if (s % 4 !== 1) voice({ type: "triangle", f: freq(roots[bar]) * (s % 8 < 4 ? 1 : 1.5), t, dur: (s % 4 === 0 ? 2 : 1) * step, vol: 0.42 });
        if (s % 8 === 0) drum(t, 150, 50, 0.12, 0.5);
        if (s % 4 === 2) hit("highpass", 7000, t, 0.04, 0.12);
        if (s === 4 || s === 12) hit("bandpass", 1800, t, 0.12, 0.22);
      },
    };
  })();

  const DESPERADO = (() => {
    const whistle = tune([
      "A4 - - - E5 - - -", "D5 C5 B4 A4 B4 - - .", "G4 - - - D5 - - -", "C5 B4 A4 G4 A4 - - .",
      "F4 - A4 - C5 - F5 -", "E5 - D5 C5 D5 - - .", "E5 - - - B4 - - -", "G#4 - - - . . . .",
      "A5 - - - G5 - E5 -", "D5 - - - E5 - - .", "G5 - - - F5 - D5 -", "C5 - - - B4 - - .",
      "A4 - C5 - F5 - - -", "E5 - - - G#4 - B4 -", "A4 - - - - - - -", ". . . . . . . .",
    ]);
    const chords = ["Am", "Am", "G", "G", "F", "F", "E", "E", "Am", "Am", "G", "G", "F", "E", "Am", "Am"];
    return {
      id: "desperado", label: "Desperado", bpm: 92, bars: 16, level: 0.55,
      play(p, t, step) {
        const bar = Math.floor(p / 16), s = p % 16;
        const [r, , fifth] = chord(chords[bar]);
        const note = whistle.get(p);
        if (note) voice({ type: "sine", f: note.f * 2, t, dur: note.len * step, vol: 0.2, attack: 0.05, sustain: 0.85, release: 0.12, vib: 0.012, vibRate: 5.2, glide: 0.97, send: 0.45 });
        // The twang: root, fifth, octave, fifth on the eighths, an octave up on the off-bars' second half.
        if (s % 2 === 0) {
          const arp = [r, fifth, r * 2, fifth][(s / 2) % 4];
          pluck(arp * 2, t, 0.13, { bright: 2600, decay: 0.42, send: 0.25 });
        }
        if (s === 0 || s === 8) voice({ type: "triangle", f: r / 2, t, dur: 6 * step, vol: 0.32, attack: 0.01, sustain: 0.5 });
        if (s === 0 && bar % 2 === 0) drum(t, 120, 42, 0.9, 0.55);
        if (s === 12 && bar % 4 === 3) drum(t, 110, 45, 0.5, 0.35);
        // Castanets on the off-beats, a soft shaker under everything.
        if (s === 6 || s === 14) { hit("bandpass", 3200, t, 0.03, 0.18, 6); hit("bandpass", 3200, t + step / 2, 0.03, 0.12, 6); }
        if (s % 2 === 1) hit("highpass", 8000, t, 0.03, 0.04);
        if ((bar === 7 && s === 12) || (bar === 15 && s === 8)) whip(t);
      },
    };
  })();

  const HOEDOWN = (() => {
    const fiddle = tune([
      "G4 A4 B4 D5 E5 D5 B4 G4", "A4 B4 A4 G4 E4 G4 - .", "C5 - E5 C5 G4 C5 E5 G5", "D5 B4 G4 B4 D5 - - .",
      "G5 F#5 E5 D5 B4 D5 E5 G5", "F#5 E5 D5 B4 A4 - - .", "D5 F#5 A5 F#5 D5 A4 F#4 A4", "D5 - - - . . D5 E5",
      "G4 A4 B4 D5 E5 D5 B4 G4", "A4 B4 A4 G4 E4 G4 - .", "C5 E5 G5 E5 C5 G4 E4 G4", "B4 D5 G5 D5 B4 G4 - .",
      "E5 - D5 B4 G4 B4 D5 E5", "C5 - B4 A4 G4 A4 B4 C5", "A4 B4 C5 D5 F#5 E5 D5 C5", "G4 - - - . . . .",
    ]);
    const chords = ["G", "G", "C", "G", "G", "G", "D", "D", "G", "G", "C", "G", "C", "C", "D", "G"];
    const roll = [2, 1, 0, 2, 1, 0, 2, 1, 3, 1, 0, 2, 1, 0, 3, 1]; // a forward roll over the chord: fifth, third, root, octave
    return {
      id: "hoedown", label: "Hoedown", bpm: 128, bars: 16, level: 0.85,
      play(p, t, step) {
        const bar = Math.floor(p / 16), s = p % 16;
        const [r, third, fifth] = chord(chords[bar]);
        const note = fiddle.get(p);
        if (note) voice({ type: "sawtooth", f: note.f, t, dur: note.len * step, vol: 0.13, attack: 0.025, sustain: 0.8, lp: 3200, vib: 0.007, vibRate: 6.2, send: 0.15 });
        const tone = [r, third, fifth, r * 2][roll[s]];
        pluck(tone * 2, t, 0.11, { bright: 5200, decay: 0.22 });
        // Boom-chick: root on 1, fifth on 3, a muted strum on 2 and 4.
        if (s === 0) voice({ type: "triangle", f: r / 2, t, dur: 3 * step, vol: 0.45, attack: 0.008, sustain: 0.4 });
        if (s === 8) voice({ type: "triangle", f: fifth / 2, t, dur: 3 * step, vol: 0.42, attack: 0.008, sustain: 0.4 });
        if (s === 4 || s === 12) { hit("bandpass", 2400, t, 0.07, 0.2, 2); drum(t, 90, 60, 0.08, 0.15); }
        hit("highpass", 6500, t, 0.025, s % 4 === 2 ? 0.07 : 0.035);
      },
    };
  })();

  const TRACKS = [GALLOP, DESPERADO, HOEDOWN];
  let track = TRACKS[0], on = true;
  try {
    on = localStorage.getItem("canon-stampede-music") !== "off";
    track = TRACKS.find((x) => x.id === localStorage.getItem("canon-stampede-track")) ?? track;
  } catch {}

  function setup() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    // A slapback echo for the whistle and the guitar: a delay feeding itself, darkened a little each time.
    const delay = ctx.createDelay(1), back = gain(0.32), tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2400;
    delay.delayTime.value = 0.32;
    wet = gain(0.6);
    wet.connect(delay).connect(tone).connect(back).connect(delay);
    tone.connect(master);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  function tick() {
    const step = 60 / track.bpm / 4;
    while (nextAt < ctx.currentTime + 0.12) {
      track.play(pos, nextAt, step);
      pos = (pos + 1) % (track.bars * 16);
      nextAt += step;
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
    master.gain.linearRampToValueAtTime(track.level, ctx.currentTime + 0.8);
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

  const save = () => {
    try {
      localStorage.setItem("canon-stampede-music", on ? "on" : "off");
      localStorage.setItem("canon-stampede-track", track.id);
    } catch {}
  };

  window.stampedeMusic = {
    get on() { return on; },
    get track() { return track.id; },
    tracks: TRACKS.map((x) => ({ id: x.id, label: x.label })),
    // Call from a click: starts the loop if music is on.
    start() { if (on) begin(); },
    set(value) {
      on = value;
      save();
      if (on) begin();
      else end();
    },
    // Switch tracks (from a click): the new one starts from its top.
    use(id) {
      track = TRACKS.find((x) => x.id === id) ?? track;
      on = true;
      save();
      if (playing) { end(); setTimeout(begin, 280); } else begin();
    },
  };
})();
