/* The background is a graphene sheet.
 *
 * Not decoration for its own sake: the subject of this tool is a hexagonal
 * lattice of carbon, so that is what sits behind it. It drifts slowly, and
 * every so often a charge travels along the bonds the way one would through
 * the real thing. It is drawn faintly enough never to compete with text,
 * pauses when the tab is hidden, and does not run at all for anyone who has
 * asked for reduced motion.
 */
(function () {
  const canvas = document.getElementById("lattice");
  if (!canvas) return;
  const reduce = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  const SIDE = 46;                     // hexagon edge, px
  const H = Math.sqrt(3) * SIDE;       // row pitch
  let w = 0, h = 0, dpr = 1, nodes = [], bonds = [], pulses = [], raf = 0;
  let t = 0, running = false;

  function colour() {
    return getComputedStyle(document.documentElement)
      .getPropertyValue("--lattice").trim() || "rgba(128,128,128,.12)";
  }

  /* A honeycomb is two offset triangular grids; build the vertices, then join
     any pair exactly one edge apart. */
  function build() {
    nodes = []; bonds = [];
    const cols = Math.ceil(w / (SIDE * 1.5)) + 2;
    const rows = Math.ceil(h / H) + 2;
    for (let c = -1; c < cols; c++) {
      for (let r = -1; r < rows; r++) {
        const x = c * SIDE * 1.5;
        const y = r * H + (c % 2 ? H / 2 : 0);
        nodes.push({ x, y, seed: Math.random() * Math.PI * 2 });
      }
    }
    const reach = SIDE * 1.08;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
        const d = Math.hypot(dx, dy);
        if (d > SIDE * 0.9 && d < reach) bonds.push([i, j]);
      }
    }
  }

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px"; canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
  }

  function spark() {
    if (!bonds.length) return;
    pulses.push({ bond: bonds[(Math.random() * bonds.length) | 0],
                  p: 0, life: 1, speed: 0.012 + Math.random() * 0.014 });
    if (pulses.length > 7) pulses.shift();
  }

  function frame() {
    if (!running) return;
    t += 0.0035;
    ctx.clearRect(0, 0, w, h);
    const base = colour();
    // The whole sheet breathes very slightly, as though under a lens.
    const driftX = Math.sin(t * 0.7) * 9, driftY = Math.cos(t * 0.5) * 7;

    ctx.lineWidth = 1;
    ctx.strokeStyle = base;
    ctx.beginPath();
    for (const [i, j] of bonds) {
      const a = nodes[i], b = nodes[j];
      ctx.moveTo(a.x + driftX, a.y + driftY);
      ctx.lineTo(b.x + driftX, b.y + driftY);
    }
    ctx.stroke();

    for (const n of nodes) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 1.6 + n.seed);
      ctx.globalAlpha = 0.25 + pulse * 0.4;
      ctx.beginPath();
      ctx.arc(n.x + driftX, n.y + driftY, 1.1 + pulse * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = base; ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (let k = pulses.length - 1; k >= 0; k--) {
      const s = pulses[k];
      s.p += s.speed;
      if (s.p >= 1) { pulses.splice(k, 1); continue; }
      const a = nodes[s.bond[0]], b = nodes[s.bond[1]];
      const x = a.x + (b.x - a.x) * s.p + driftX;
      const y = a.y + (b.y - a.y) * s.p + driftY;
      const fade = Math.sin(s.p * Math.PI);
      const glow = ctx.createRadialGradient(x, y, 0, x, y, 26);
      glow.addColorStop(0, base.replace(/[\d.]+\)$/, (0.75 * fade) + ")"));
      glow.addColorStop(1, base.replace(/[\d.]+\)$/, "0)"));
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(x, y, 26, 0, Math.PI * 2); ctx.fill();
    }

    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduce) return;
    running = true; raf = requestAnimationFrame(frame);
  }
  function stop() { running = false; cancelAnimationFrame(raf); }

  size();
  if (reduce) {                       // a still lattice, no movement at all
    ctx.strokeStyle = colour(); ctx.lineWidth = 1; ctx.beginPath();
    for (const [i, j] of bonds) {
      ctx.moveTo(nodes[i].x, nodes[i].y); ctx.lineTo(nodes[j].x, nodes[j].y);
    }
    ctx.stroke();
    return;
  }

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(size, 180);
  });
  document.addEventListener("visibilitychange",
    () => (document.hidden ? stop() : start()));
  setInterval(() => { if (running && Math.random() < 0.55) spark(); }, 1400);
  start();
})();
