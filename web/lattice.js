/* The background is a sheet of graphene, and it costs almost nothing to show.
 *
 * The subject of this tool is a hexagonal lattice of carbon, so that is what
 * sits behind it - not an abstract gradient. The sheet is built in three
 * dimensions, projected through a camera so bonds nearer the viewer are
 * brighter and thicker, and charge carriers run along the bonds the way they
 * do in the real material.
 *
 * The first version of this redrew all of that every frame: a standing wave,
 * a drifting camera and live parallax meant every node had to be projected
 * and every bond stroked sixty times a second. Measured on a throttled phone
 * that was 4,886 canvas operations per frame, the page settled at 30fps, and
 * three quarters of frames missed their budget. The sheet was costing more
 * than the application.
 *
 * So the work is split by what actually changes. The sheet is painted once,
 * into its own layer, and then moved by the compositor - a transform costs
 * the processor nothing, which is the whole reason to prefer one. Only the
 * carriers are redrawn, and there are seven of them. Per frame this is about
 * thirty operations instead of five thousand.
 *
 * What that trades away is the standing wave: the sheet no longer breathes,
 * because a deforming sheet cannot be painted once. It drifts and it
 * conducts, which is the part worth having.
 *
 * It pauses when the tab is hidden, and anyone who has asked for reduced
 * motion gets the sheet with no drift and no carriers at all.
 */
(function () {
  const host = document.getElementById("lattice");
  if (!host) return;

  const reduce = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const SIDE = 52;          // hexagon edge in world units
  const FOV = 900;          // camera focal length
  const DEPTH = 1950;       // camera distance
  const TILT = -0.66;       // how far the sheet lies back
  const YAW = 0.07;
  const BLEED = 0.14;       // extra sheet beyond the viewport, for drifting
  const CARRIERS = 7;

  // Two layers so the two jobs stay apart: the sheet is painted once and
  // never touched again, the carriers are cleared and redrawn.
  // Both canvases live inside one wrapper so a single compositor layer
  // carries them, and the drift is a CSS animation on that wrapper rather
  // than arithmetic in the frame loop. The host above it takes the parallax,
  // so the two transforms never fight over the same property.
  const drift = document.createElement("div");
  drift.className = "lat-drift";
  const sheet = document.createElement("canvas");
  const flow = document.createElement("canvas");
  sheet.className = "lat-sheet";
  flow.className = "lat-flow";
  drift.appendChild(sheet);
  drift.appendChild(flow);
  host.appendChild(drift);
  const sctx = sheet.getContext("2d");
  const fctx = flow.getContext("2d", { alpha: true });
  if (!sctx || !fctx) return;

  let w = 0, h = 0, dpr = 1, cw = 0, ch = 0;
  let nodes = [], bonds = [], pulses = [];
  let raf = 0, running = false, last = 0;

  const css = (name, fallback) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    || fallback;

  /* ---- geometry ---------------------------------------------------- */

  /* Six vertices per hexagon, deduplicated. An earlier version placed
     vertices on a triangular grid and joined any pair one bond apart, but on
     that grid the nearest neighbour sits at 1.73 bond lengths, so no pair
     ever matched and the sheet had no bonds at all. */
  function build() {
    nodes = []; bonds = [];
    const R = SIDE;
    const colW = Math.sqrt(3) * R;
    const rowH = 1.5 * R;
    const spanX = Math.max(cw, 900) * 1.7;
    const spanY = Math.max(ch, 700) * 1.7;
    const cols = Math.ceil(spanX / colW) + 2;
    const rows = Math.ceil(spanY / rowH) + 2;

    const index = new Map();
    const key = (x, y) => Math.round(x / 2) + ":" + Math.round(y / 2);
    const vertex = (x, y) => {
      const k = key(x, y);
      let id = index.get(k);
      if (id === undefined) {
        id = nodes.length;
        index.set(k, id);
        nodes.push({ x, y, sx: 0, sy: 0, s: 1, adj: [] });
      }
      return id;
    };

    const seen = new Set();
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const cx = (c - cols / 2) * colW + (r % 2 ? colW / 2 : 0);
        const cy = (r - rows / 2) * rowH;
        const ring = [];
        for (let k = 0; k < 6; k++) {
          const a = Math.PI / 180 * (60 * k - 30);
          ring.push(vertex(cx + R * Math.cos(a), cy + R * Math.sin(a)));
        }
        for (let k = 0; k < 6; k++) {
          const a = ring[k], b = ring[(k + 1) % 6];
          const bk = a < b ? a + ":" + b : b + ":" + a;
          if (seen.has(bk)) continue;
          seen.add(bk);
          bonds.push({ a, b });
        }
      }
    }
    bonds.forEach((bd, i) => { nodes[bd.a].adj.push(i); nodes[bd.b].adj.push(i); });
    pulses = [];
    for (let i = 0; i < CARRIERS; i++) pulses.push(spawn());
  }

  function spawn() {
    return { bond: (Math.random() * bonds.length) | 0, u: Math.random(),
             dir: Math.random() < 0.5 ? 1 : -1,
             speed: 0.009 + Math.random() * 0.011,
             life: 0, max: 280 + Math.random() * 340, box: null };
  }

  /* ---- camera ------------------------------------------------------
     Projected once, at a fixed camera. Nothing here runs per frame, which
     is the entire point: a sheet that is never re-projected can be painted
     into a layer and moved by the compositor instead. */
  function project() {
    const ca = Math.cos(TILT), sa = Math.sin(TILT);
    const cb = Math.cos(YAW), sb = Math.sin(YAW);
    for (const n of nodes) {
      const y1 = n.y * ca;
      const z1 = n.y * sa;
      const x2 = n.x * cb + z1 * sb;
      const z2 = -n.x * sb + z1 * cb;
      const d = DEPTH + z2;
      const s = d > 1 ? FOV / d : 0;
      n.sx = cw / 2 + x2 * s;
      n.sy = ch * 0.44 + y1 * s;
      n.s = s;
    }
  }

  /* ---- the sheet, painted once ------------------------------------- */

  function paintSheet() {
    const line = css("--lattice-line", "rgba(120,130,140,.45)");
    const node = css("--lattice-node", "rgba(120,130,140,.5)");
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, cw, ch);
    sctx.lineCap = "round";

    for (const bd of bonds) {
      const a = nodes[bd.a], b = nodes[bd.b];
      if (!a.s || !b.s) continue;
      const depth = (a.s + b.s) / 2;
      // Nearer bonds are thicker and brighter; the far edge falls away.
      const fade = Math.max(0, Math.min(1, (depth - 0.25) / 0.45));
      if (fade <= 0.02) continue;
      sctx.globalAlpha = 0.10 + fade * 0.55;
      sctx.lineWidth = 0.35 + fade * 1.05;
      sctx.strokeStyle = line;
      sctx.beginPath();
      sctx.moveTo(a.sx, a.sy);
      sctx.lineTo(b.sx, b.sy);
      sctx.stroke();
    }
    sctx.fillStyle = node;
    for (const n of nodes) {
      const fade = Math.max(0, Math.min(1, (n.s - 0.3) / 0.45));
      if (fade <= 0.05) continue;
      sctx.globalAlpha = fade * 0.5;
      sctx.beginPath();
      sctx.arc(n.sx, n.sy, 0.5 + fade * 1.1, 0, 6.2832);
      sctx.fill();
    }
    sctx.globalAlpha = 1;
  }

  /* ---- the carriers, the only thing drawn per frame ----------------- */

  function advance(dt) {
    for (let i = 0; i < pulses.length; i++) {
      const p = pulses[i];
      p.life += dt;
      p.u += p.dir * p.speed * (dt / 16.67);
      if (p.u > 1 || p.u < 0) {
        // Turn the corner onto a bond that shares this node.
        const bd = bonds[p.bond];
        const at = p.u > 1 ? (p.dir > 0 ? bd.b : bd.a) : (p.dir > 0 ? bd.a : bd.b);
        const adj = nodes[at].adj;
        const next = adj[(Math.random() * adj.length) | 0];
        const nb = bonds[next];
        p.bond = next;
        p.dir = nb.a === at ? 1 : -1;
        p.u = nb.a === at ? 0 : 1;
      }
      if (p.life > p.max) {
        const box = p.box;
        pulses[i] = spawn();
        pulses[i].box = box;       // so the old mark is still wiped
      }
    }
  }

  /* Only what moved is cleared.
     Clearing the whole layer wiped 1,996 by 4,320 pixels every frame to draw
     seven dots, and that alone was dropping one frame in five on a throttled
     phone. Each carrier remembers the box it drew into and clears that box
     instead - seven small rectangles rather than one enormous one. */
  function paintFlow() {
    const glow = css("--lattice-glow", "#7FD4E8");
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const p of pulses) {
      if (!p.box) continue;
      fctx.clearRect(p.box[0], p.box[1], p.box[2], p.box[3]);
      p.box = null;
    }
    fctx.lineCap = "round";
    fctx.strokeStyle = glow;
    for (const p of pulses) {
      const bd = bonds[p.bond];
      if (!bd) continue;
      const a = nodes[bd.a], b = nodes[bd.b];
      const depth = (a.s + b.s) / 2;
      if (depth < 0.3) continue;
      const fade = Math.max(0, Math.min(1, (depth - 0.3) / 0.45));
      // Fade in and out over the carrier's life so none of them pops.
      const life = Math.min(1, p.life / 260) * Math.min(1, (p.max - p.life) / 260);
      const alpha = fade * Math.max(0, life) * 0.85;
      if (alpha <= 0.02) continue;
      const tail = Math.max(0, p.u - p.dir * 0.22);
      const x0 = a.sx + (b.sx - a.sx) * tail, y0 = a.sy + (b.sy - a.sy) * tail;
      const x1 = a.sx + (b.sx - a.sx) * p.u, y1 = a.sy + (b.sy - a.sy) * p.u;
      const width = 0.8 + fade * 1.6;
      fctx.globalAlpha = alpha;
      fctx.lineWidth = width;
      fctx.beginPath();
      fctx.moveTo(x0, y0);
      fctx.lineTo(x1, y1);
      fctx.stroke();
      // Remember what to wipe next frame, padded for the round cap.
      const pad = width + 2;
      p.box = [Math.min(x0, x1) - pad, Math.min(y0, y1) - pad,
               Math.abs(x1 - x0) + pad * 2, Math.abs(y1 - y0) + pad * 2];
    }
    fctx.globalAlpha = 1;
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(48, now - (last || now));
    last = now;
    advance(dt);
    paintFlow();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduce || !bonds.length) return;
    running = true; last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  /* ---- size --------------------------------------------------------- */

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = window.innerWidth;
    h = window.innerHeight;
    cw = Math.round(w * (1 + BLEED * 2));
    ch = Math.round(h * (1 + BLEED * 2));
    for (const c of [sheet, flow]) {
      c.width = Math.round(cw * dpr);
      c.height = Math.round(ch * dpr);
      c.style.width = cw + "px";
      c.style.height = ch + "px";
      c.style.left = -Math.round(w * BLEED) + "px";
      c.style.top = -Math.round(h * BLEED) + "px";
    }
    build();
    project();
    paintSheet();
    if (!reduce) paintFlow();
  }

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 200);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop(); else start();
  });

  // The sheet is a few thousand strokes, once. Off the critical path, so it
  // never delays the first thing the reader sees.
  const begin = () => { resize(); start(); };
  if (window.requestIdleCallback) requestIdleCallback(begin, { timeout: 1200 });
  else setTimeout(begin, 120);

  // Repainted once when the palette changes, rather than watched per frame.
  window.addEventListener("gba:theme", () => { project(); paintSheet(); });

  /* Parallax, gentle enough to read as depth rather than as a toy. It writes
     one transform at most once a frame and never reads layout, so it stays
     on the compositor; on a touch screen there is no pointer to follow and
     the listener is never attached. */
  if (!reduce && window.matchMedia
      && window.matchMedia("(pointer:fine)").matches) {
    let px = 0, py = 0, queued = false;
    const apply = () => {
      queued = false;
      host.style.transform = `translate3d(${px.toFixed(2)}%, ${py.toFixed(2)}%, 0)`;
    };
    window.addEventListener("pointermove", (e) => {
      px = (e.clientX / window.innerWidth - 0.5) * -1.6;
      py = (e.clientY / window.innerHeight - 0.5) * -1.2;
      if (!queued) { queued = true; requestAnimationFrame(apply); }
    }, { passive: true });
  }
})();
