/* What the agent looks like while it is thinking: a sheet of graphene growing
 * in open space, below the question. No panel, no frame, no card.
 *
 * It is a lit surface, not a wire drawing. Each hexagon is a face with a real
 * surface normal taken from the standing wave running through the sheet; that
 * normal is rotated with the sheet and dotted against a fixed light, so cells
 * tilted toward the light are bright and cells tilted away fall into shadow.
 * Faces are sorted back to front before they are drawn, so near cells occlude
 * far ones. Those three things - perspective, shading, occlusion - are what
 * make a thing read as three-dimensional. An earlier version had only the
 * first and looked flat, which it was.
 *
 * It is also a progress bar. The sheet crystallises outward one ring per step
 * the agent finishes, so how far it has grown is how far the research has got.
 * The front edge glows; everything behind it has settled into the lattice.
 *
 * Reduced motion gets a still, lit sheet that still grows, because the growth
 * carries information and the tumbling does not.
 */
(function (global) {
  const TAU = Math.PI * 2;

  function create(canvas, opts) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return { step() {}, done() {}, stop() {}, resize() {} };
    const reduce = window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const R = 25;                 // bond length, world units
    const RINGS = 7;
    const FOV = 760, DEPTH = 980;
    const AMP = R * 1.15;         // wave height
    const KX = 0.0105, KY = 0.0125, WT = 0.0019;

    let w = 0, h = 0, dpr = 1, fit = 1;
    let cells = [], verts = [], raf = 0, t = 0, running = true;
    let grown = 0.18, target = 0.48, maxRing = 1, steps = 0;
    let spin = 1, flash = 0;

    const css = (n, f) => getComputedStyle(document.documentElement)
      .getPropertyValue(n).trim() || f;

    /* ---- the sheet: hexagonal faces, not just bonds ----------------- */

    function build() {
      cells = []; verts = [];
      const colW = Math.sqrt(3) * R, rowH = 1.5 * R;
      const index = new Map();
      const key = (x, y) => Math.round(x) + ":" + Math.round(y);
      const vertex = (x, y) => {
        const k = key(x, y);
        let id = index.get(k);
        if (id === undefined) {
          id = verts.length;
          verts.push({ x, y, sx: 0, sy: 0, sz: 0, s: 1 });
        }
        if (id === verts.length - 1) index.set(k, id);
        return id;
      };

      for (let c = -RINGS - 1; c <= RINGS + 1; c++) {
        for (let r = -RINGS - 1; r <= RINGS + 1; r++) {
          const cx = c * colW + (r % 2 ? colW / 2 : 0);
          const cy = r * rowH;
          const ring = Math.hypot(cx, cy) / (R * 1.5);
          if (ring > RINGS) continue;
          const ring6 = [];
          for (let k = 0; k < 6; k++) {
            const th = (Math.PI / 3) * k - Math.PI / 2;
            ring6.push(vertex(cx + R * Math.cos(th), cy + R * Math.sin(th)));
          }
          cells.push({ v: ring6, cx, cy, ring, z: 0, light: 0, depth: 0 });
        }
      }
      maxRing = cells.reduce((m, c) => Math.max(m, c.ring), 1);
      cells.sort((a, b) => a.ring - b.ring);
    }

    /* ---- camera and light ------------------------------------------ */

    /* The sheet is a height field z = f(x,y). Its normal is
       (-df/dx, -df/dy, 1), which is exact rather than estimated, so the
       shading is the real shape of the wave rather than a fake gradient. */
    function height(x, y, tt) {
      return Math.sin(x * KX + y * KY + tt * WT) * AMP;
    }
    function slope(x, y, tt) {
      const c = Math.cos(x * KX + y * KY + tt * WT) * AMP;
      return [c * KX, c * KY];
    }

    const LIGHT = (() => {
      const v = [-0.38, -0.66, -0.65];
      const m = Math.hypot(v[0], v[1], v[2]);
      return [v[0] / m, v[1] / m, v[2] / m];
    })();

    let ca = 1, sa = 0, cb = 1, sb = 0;

    function camera() {
      const s = reduce ? 0 : spin;
      // Tumble on both axes, enough to see it turn rather than drift.
      // Keep it facing the viewer. A full tumble swings the sheet edge-on
      // and a plane seen edge-on is a line, which reads as a blade rather
      // than a surface. Enough rotation to see it turn, not enough to lose it.
      const ax = -0.62 + Math.sin(t * 0.00048) * 0.15 * s;
      const ay = Math.sin(t * 0.00031) * 0.34 * s + Math.sin(t * 0.00013) * 0.12 * s;
      ca = Math.cos(ax); sa = Math.sin(ax);
      cb = Math.cos(ay); sb = Math.sin(ay);
    }

    function rotate(x, y, z) {
      const y1 = y * ca - z * sa;
      const z1 = y * sa + z * ca;
      return [x * cb + z1 * sb, y1, -x * sb + z1 * cb];
    }

    function project() {
      const tt = reduce ? 0 : t;
      for (const v of verts) {
        const z = height(v.x, v.y, tt);
        const [X, Y, Z] = rotate(v.x, v.y, z);
        const d = DEPTH + Z;
        const s = d > 1 ? (FOV * fit) / d : 0;
        v.sx = w / 2 + X * s;
        v.sy = h * 0.455 + Y * s;   // the tilt puts the centroid low; lift it
        v.sz = Z;
        v.s = s;
      }
      for (const c of cells) {
        let z = 0;
        for (const i of c.v) z += verts[i].sz;
        c.z = z / 6;
        const [dx, dy] = slope(c.cx, c.cy, tt);
        // normal of the height field, rotated with the sheet
        let n = rotate(-dx, -dy, 1);
        const m = Math.hypot(n[0], n[1], n[2]) || 1;
        const dot = -(n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]) / m;
        c.light = Math.max(0, dot);
        c.depth = Math.max(0, Math.min(1, 1 - (c.z + 300) / 620));
      }
      // painter's algorithm: far cells first, so near ones cover them
      cells.sort((a, b) => b.z - a.z);
    }

    /* ---- paint ------------------------------------------------------ */

    /* Two tones, not one with varying opacity. A single tint can only get
       more opaque as a face catches more light, which on a light page makes
       the lit side darker than the shadow - the shading read backwards. So a
       face is mixed between a shadow colour and a lit colour. */
    const triple = (s) => s.split(",").map(Number);
    function mix(a, b, k) {
      return [Math.round(a[0] + (b[0] - a[0]) * k),
              Math.round(a[1] + (b[1] - a[1]) * k),
              Math.round(a[2] + (b[2] - a[2]) * k)];
    }

    function paint() {
      ctx.clearRect(0, 0, w, h);
      const acc = css("--acc", "#8A6A2F");
      const hot = css("--acc-hi", acc);
      const litC = triple(css("--anim-lit", "226,196,140"));
      const darkC = triple(css("--anim-dark", "120,92,42"));
      const edgeC = css("--anim-edge", "138,106,47");
      const face = css("--anim-lit", "226,196,140");
      const edge = grown * maxRing;

      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      for (const c of cells) {
        const d = edge - c.ring;
        if (d < -0.75) continue;                 // not grown yet
        const front = d < 0.75 ? 1 - Math.abs(d) / 0.75 : 0;

        let ok = true;
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const v = verts[c.v[k]];
          if (v.s <= 0) { ok = false; break; }
          if (k === 0) ctx.moveTo(v.sx, v.sy); else ctx.lineTo(v.sx, v.sy);
        }
        if (!ok) continue;
        ctx.closePath();

        // the face: its own normal picks the tone, distance picks the weight
        const k = Math.min(1, c.light * 1.1 + front * 0.4 + flash * 0.45);
        const [r, g, bl] = mix(darkC, litC, k);
        const a = 0.62 + 0.3 * c.depth;
        ctx.fillStyle = `rgba(${r},${g},${bl},${Math.min(0.95, a).toFixed(3)})`;
        ctx.fill();

        // the edges: the lattice itself, bright at the growth front
        const near = (verts[c.v[0]].s + verts[c.v[3]].s) / 2;
        ctx.strokeStyle = front > 0 || flash > 0
          ? hot
          : `rgba(${edgeC},${(0.3 + 0.55 * c.depth).toFixed(3)})`;
        ctx.globalAlpha = front > 0 ? 0.55 + front * 0.45
                                    : Math.min(1, 0.5 + flash);
        ctx.lineWidth = Math.max(0.6, near * (front > 0 ? 2.2 : 1.25));
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // a highlight sweeping the surface, so the eye reads a solid sheet
      if (!reduce) {
        const sweep = (Math.sin(t * 0.0009) * 0.5 + 0.5) * w;
        const g = ctx.createLinearGradient(sweep - w * 0.26, 0, sweep + w * 0.26, 0);
        g.addColorStop(0, "transparent");
        g.addColorStop(0.5, `rgba(${face},.1)`);
        g.addColorStop(1, "transparent");
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "source-over";
      }
    }

    /* ---- loop -------------------------------------------------------- */

    function frame(now) {
      if (!running) return;
      t = now;
      grown += (target - grown) * 0.05;
      if (flash > 0) flash -= 0.018;
      camera(); project(); paint();
      raf = requestAnimationFrame(frame);
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(100, rect.width); h = Math.max(100, rect.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // The sheet is about 2 * RINGS * 1.5 * R wide; fit it to the smaller edge.
      // Height is the binding edge on every screen, so size off it and let
      // width only veto. Measured: this puts the sheet at ~80% of the canvas
      // on desktop and ~75% on a phone, instead of the 52% it filled before.
      fit = Math.max(0.5, Math.min(1.7, Math.min(w / 410, h / 288)));
    }

    window.addEventListener("resize", resize);

    resize();
    build();
    raf = requestAnimationFrame(frame);

    return {
      step(n) {
        steps = typeof n === "number" ? n : steps + 1;
        target = Math.min(1, 0.48 + steps * 0.1);
      },
      done() { target = 1; flash = 1; spin = 0.42; },
      stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0;
               window.removeEventListener("resize", resize); },
      resize,
    };
  }

  global.ResearchAnim = { create };
})(window);
