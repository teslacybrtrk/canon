// Canon Stampede's music: "Keep It Canon", looped without a gap through Web Audio. Browsers only allow sound after
// a click, so the game calls start() from one; the choice is remembered per browser.
(() => {
  const SRC = "/keep-it-canon.m4a";
  const VOLUME = 0.35; // the song is mastered loud; this sits it under the game's sound effects

  let on = true;
  try { on = localStorage.getItem("canon-stampede-music") !== "off"; } catch {}
  let ctx = null, master = null, buffer = null, loading = null, source = null, playing = false;

  function load() {
    loading ??= fetch(SRC)
      .then((r) => r.arrayBuffer())
      .then((data) => new Promise((resolve, reject) => ctx.decodeAudioData(data, resolve, reject)))
      .then((b) => (buffer = b))
      .catch(() => (loading = null));
    return loading;
  }

  async function begin() {
    if (playing) return;
    playing = true;
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
    }
    ctx.resume();
    await load();
    if (!playing || !buffer || source) return;
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(master);
    source.start();
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(0, ctx.currentTime);
    master.gain.linearRampToValueAtTime(VOLUME, ctx.currentTime + 0.8);
  }

  function end() {
    if (!playing) return;
    playing = false;
    if (!source) return;
    const s = source;
    source = null;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
    master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
    s.stop(ctx.currentTime + 0.3);
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
