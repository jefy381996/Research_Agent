/* The background is a sheet of graphene, seen in perspective.
 *
 * The subject of this tool is a hexagonal lattice of carbon, so that is what
 * sits behind it - not an abstract gradient. The sheet is built in three
 * dimensions, given a slow standing wave, rotated, and projected through a
 * camera, so bonds nearer the viewer are brighter and thicker and the far
 * edge falls away. Charge carriers run along the bonds the way they do in the
 * real material, which is the one thing graphene is most famous for.
 *
 * It has to be visible to be worth drawing at all - an earlier version used
 * 10% alpha hairlines and could not be seen on any screen - but it must never
 * compete with text. Depth does that work: the bright bonds are the far ones
 * behind the page's margins, and everything under the reading column is dim.
 *
 * It pauses when the tab is hidden and does not run at all for anyone who has
 * asked for reduced motion, who gets a single still frame instead.
 */
(function () {
  const canvas = document.getElementById("lattice");
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  const reduce = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const SIDE = 42;          // hexagon edge in world units
  const FOV = 900;          // camera focal length
  const DEPTH = 1950;       // camera distance
  const WAVE = 46;          // amplitude of the standing wave, world units

  let w = 0, h = 0, dpr = 1;
  let nodes = [], bonds = [], pulses = [];
  let raf = 0, t = 0, running = false, started = 0;
  let px = 0, py = 0, tx = 0, ty = 0;        // parallax, eased

  const css = (name, fallback) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    || fallback;

  /* ---- geometry ---------------------------------------------------- */

  /* Build the honeycomb out of actual hexagons rather than guessing at a
     grid. An earlier version placed vertices on a triangular lattice and then
     joined any pair one bond apart - but on that grid the nearest neighbour
     sits at 1.73 bond lengths, so no pair ever matched and the sheet had no
     bonds at all. Six vertices per hexagon, deduplicated, is unambiguous. */
  function build() {
    nodes = []; bonds = [];
    const R = SIDE;                       // circumradius == bond length
    const colW = Math.sqrt(3) * R;        // centre spacing across
    const rowH = 1.5 * R;                 // centre spacing down
    const spanX = Math.max(w, 900) * 1.6;
    const spanY = Math.max(h, 700) * 1.6;
    const cols = Math.ceil(spanX / colW) + 2;
    const rows = Math.ceil(spanY / rowH) + 2;

    const index = new Map();              // rounded position -> node id
    const key = (x, y) => Math.round(x / 2) + ":" + Math.round(y / 2);
    const vertex = (x, y) => {
      const k = key(x, y);
      let id = index.get(k);
      if (id === undefined) {
        id = nodes.length;
        index.set(k, id);
        nodes.push({ x, y, z: 0, sx: 0, sy: 0, sz: 0, s: 1, adj: [],
                     phase: x * 0.004 + y * 0.006 });
      }
      return id;
    };

    const edges = new Set();
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const cx = -spanX / 2 + c * colW + (r % 2 ? colW / 2 : 0);
        const cy = -spanY / 2 + r * rowH;
        const ring = [];
        for (let k = 0; k < 6; k++) {
          const th = (Math.PI / 3) * k - Math.PI / 2;
          ring.push(vertex(cx + R * Math.cos(th), cy + R * Math.sin(th)));
        }
        for (let k = 0; k < 6; k++) {
          const a = ring[k], b = ring[(k + 1) % 6];
          const ek = a < b ? a + "-" + b : b + "-" + a;
          if (edges.has(ek)) continue;
          edges.add(ek);
          bonds.push({ a, b });
        }
      }
    }

    // Adjacency, so a carrier can walk the lattice bond by bond.
    bonds.forEach((bd, i) => { nodes[bd.a].adj.push(i); nodes[bd.b].adj.push(i); });

    pulses = [];
    if (!bonds.length) return;
    const count = reduce ? 0 : Math.min(8, Math.max(4, Math.round(w / 360)));
    for (let i = 0; i < count; i++) pulses.push(spawn());
  }

  function spawn() {
    let at = (Math.random() * bonds.length) | 0;
    return { bond: at, u: Math.random(), dir: Math.random() < 0.5 ? 1 : -1,
             speed: 0.010 + Math.random() * 0.012,
             life: 0, max: 260 + Math.random() * 300 };
  }

  /* ---- camera ------------------------------------------------------ */

  /* Rotate the sheet, give it a standing wave, then project. Screen scale is
     kept per node so bonds can be drawn with depth-correct width. */
  function project() {
    const ax = -0.70 + Math.sin(t * 0.00013) * 0.05 + ty * 0.09;  // tilt back
    const ay = Math.sin(t * 0.00009) * 0.18 + px * 0.16;          // slow yaw
    const ca = Math.cos(ax), sa = Math.sin(ax);
    const cb = Math.cos(ay), sb = Math.sin(ay);
    const drift = t * 0.012;

    for (const n of nodes) {
      // standing wave, so the sheet breathes rather than sliding rigidly
      const z = Math.sin(n.phase + t * 0.0011) * WAVE
              + Math.cos(n.x * 0.0022 - t * 0.0007) * WAVE * 0.5;
      const x0 = n.x + drift % (SIDE * 3);
      const y0 = n.y;

      const y1 = y0 * ca - z * sa;          // rotate about X
      const z1 = y0 * sa + z * ca;
      const x2 = x0 * cb + z1 * sb;         // rotate about Y
      const z2 = -x0 * sb + z1 * cb;

      const d = DEPTH + z2;
      const s = d > 1 ? FOV / d : 0;
      n.sx = w / 2 + x2 * s;
      n.sy = h * 0.46 + y1 * s;
      n.sz = z2;
      n.s = s;
    }
  }

  /* ---- paint ------------------------------------------------------- */

  function paint() {
    ctx.clearRect(0, 0, w, h);

    const line = css("--lattice-line", "rgba(120,98,60,.5)");
    const glow = css("--lattice-glow", "#8A6A2F");
    const node = css("--lattice-node", "rgba(120,98,60,.55)");

    // Reading column: bonds crossing the middle of the screen are damped, so
    // text always wins. Everything outside it is allowed to be bright.
    const colL = w / 2 - Math.min(560, w * 0.42);
    const colR = w / 2 + Math.min(560, w * 0.42);
    const damp = (x) => (x > colL && x < colR ? 0.32 : 1);

    // Entrance: the sheet assembles outward from the middle on first paint.
    const age = started ? Math.min(1, (performance.now() - started) / 2200) : 1;
    const ease = 1 - Math.pow(1 - age, 3);
    const reach = ease * Math.hypot(w, h) * 0.85;

    ctx.lineCap = "round";
    for (const bd of bonds) {
      const a = nodes[bd.a], b = nodes[bd.b];
      if (a.s <= 0 || b.s <= 0) continue;
      const mx = (a.sx + b.sx) / 2, my = (a.sy + b.sy) / 2;
      if (mx < -60 || mx > w + 60 || my < -60 || my > h + 60) continue;
      if (age < 1 && Math.hypot(mx - w / 2, my - h * 0.52) > reach) continue;

      const s = (a.s + b.s) / 2;
      // Depth fade: near bonds are solid, far ones dissolve.
      const dz = (a.sz + b.sz) / 2;
      let alpha = Math.max(0, Math.min(1, 1 - (dz + 520) / 1500));
      alpha *= damp(mx) * (age < 1 ? ease : 1);
      if (alpha < 0.02) continue;

      ctx.globalAlpha = alpha;
      ctx.strokeStyle = line;
      ctx.lineWidth = Math.max(0.5, s * 1.15);
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }

    // Vertices, only the near ones, so the sheet reads as a surface.
    ctx.fillStyle = node;
    for (const n of nodes) {
      if (n.s <= 0 || n.sz > -120) continue;
      if (n.sx < 0 || n.sx > w || n.sy < 0 || n.sy > h) continue;
      const alpha = Math.max(0, Math.min(1, 1 - (n.sz + 520) / 1100)) * damp(n.sx);
      if (alpha < 0.05) continue;
      ctx.globalAlpha = alpha * 0.75 * (age < 1 ? ease : 1);
      ctx.beginPath();
      ctx.arc(n.sx, n.sy, Math.max(0.6, n.s * 1.5), 0, Math.PI * 2);
      ctx.fill();
    }

    // Carriers. A travelling charge is the one thing everyone knows graphene
    // for, and it is what makes the sheet read as a conductor rather than a
    // wallpaper.
    for (const p of pulses) {
      const bd = bonds[p.bond];
      if (!bd) continue;
      const a = nodes[bd.a], b = nodes[bd.b];
      if (a.s <= 0 || b.s <= 0) continue;
      const u = p.dir > 0 ? p.u : 1 - p.u;
      const x = a.sx + (b.sx - a.sx) * u;
      const y = a.sy + (b.sy - a.sy) * u;
      if (x < -40 || x > w + 40 || y < -40 || y > h + 40) continue;

      const fade = Math.min(1, p.life / 40) * Math.min(1, (p.max - p.life) / 60);
      const s = (a.s + b.s) / 2;
      const r = Math.max(2.5, s * 7);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, glow);
      g.addColorStop(1, "transparent");
      ctx.globalAlpha = 0.55 * fade * damp(x) * (age < 1 ? ease : 1);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();

      // a short trail along the bond it is on
      ctx.globalAlpha = 0.5 * fade * damp(x);
      ctx.strokeStyle = glow;
      ctx.lineWidth = Math.max(0.8, s * 1.9);
      const back = Math.max(0, u - 0.4 * p.dir * p.dir);
      ctx.beginPath();
      ctx.moveTo(a.sx + (b.sx - a.sx) * back, a.sy + (b.sy - a.sy) * back);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function advance(dt) {
    t += dt;
    if (!bonds.length) return;
    px += (tx - px) * 0.045;
    py += (ty - py) * 0.045;
    for (let i = 0; i < pulses.length; i++) {
      const p = pulses[i];
      const cur = bonds[p.bond];
      if (!cur) { pulses[i] = spawn(); continue; }
      p.u += p.speed;
      p.life += 1;
      if (p.u >= 1) {
        // hop to a connected bond, so the carrier walks the lattice
        const at = p.dir > 0 ? cur.b : cur.a;
        const options = nodes[at].adj.filter((x) => x !== p.bond);
        if (!options.length || p.life > p.max) { pulses[i] = spawn(); continue; }
        const next = options[(Math.random() * options.length) | 0];
        const nb = bonds[next];
        p.dir = nb.a === at ? 1 : -1;
        p.bond = next;
        p.u = 0;
      }
      if (p.life > p.max) pulses[i] = spawn();
    }
  }

  /* ---- loop -------------------------------------------------------- */

  let last = 0;
  function frame(now) {
    if (!running) return;
    const dt = Math.min(48, now - (last || now));
    last = now;
    advance(dt);
    project();
    paint();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduce) return;
    running = true; last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    build();
    if (reduce) { project(); paint(); }
  }

  window.addEventListener("resize", () => {
    clearTimeout(resize._t);
    resize._t = setTimeout(resize, 160);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop(); else start();
  });

  // Parallax, gentle enough to read as depth rather than as a toy.
  window.addEventListener("pointermove", (e) => {
    tx = (e.clientX / window.innerWidth - 0.5) * 2;
    ty = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  resize();
  started = performance.now();
  start();

  // Repaint once when the palette changes, so the colours follow the theme
  // even while the tab is hidden.
  window.addEventListener("gba:theme", () => { if (!running) { project(); paint(); } });
})();
