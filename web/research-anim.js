/* What the agent looks like while it is thinking.
 *
 * Graphene is grown in a reactor: carbon lands on a hot surface and locks into
 * a hexagonal lattice, ring by ring, outward from a seed. That is what this
 * draws, in perspective, as a sheet suspended in space - and it is a progress
 * bar, not an ornament. Every ring that crystallises is one step the agent has
 * actually finished, so the sheet is as far along as the research is.
 *
 * The sheet rotates in three dimensions, lifts on a standing wave, and carries
 * charge along the bonds that exist so far. When the answer arrives the
 * rotation eases to rest and the whole lattice lights once, edge to edge.
 *
 * Anyone who has asked for reduced motion gets a still sheet that still grows,
 * because the growth is information and the spin is not.
 */
(function (global) {
  const TAU = Math.PI * 2;

  function create(canvas, opts) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return { step() {}, done() {}, stop() {} };
    const reduce = window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const R = (opts && opts.side) || 26;     // bond length, world units
    const FOV = 560, DEPTH = 760;
    let w = 0, h = 0, dpr = 1, fit = 1;
    let nodes = [], bonds = [], carriers = [];
    let raf = 0, t = 0, running = true;
    let grown = 0.2, target = 0.34, maxRing = 1;
    let settle = 0, flash = 0, spin = 1, steps = 0;

    /* The stage is an instrument panel, not part of the page: deep ink with a
       gold lattice, in light and dark alike. Reading the page palette here
       made the sheet almost invisible on the light theme, which is the one
       most people will demo on. */
    const HOT = (opts && opts.hot) || "#F0CE8A";     // the growth front
    const COOL = (opts && opts.cool) || "rgba(226,190,122,.62)";
    const GLOW = (opts && opts.glow) || "#FFD98F";

    /* ---- the sheet ------------------------------------------------- */

    function build() {
      nodes = []; bonds = [];
      const rings = 8;
      const colW = Math.sqrt(3) * R, rowH = 1.5 * R;
      const index = new Map();
      const key = (x, y) => Math.round(x) + ":" + Math.round(y);
      const vertex = (x, y, ring) => {
        const k = key(x, y);
        let id = index.get(k);
        if (id === undefined) {
          id = nodes.length;
          index.set(k, id);
          nodes.push({ x, y, ring, sx: 0, sy: 0, sz: 0, s: 1, adj: [],
                       phase: Math.hypot(x, y) * 0.02 });
        } else {
          nodes[id].ring = Math.min(nodes[id].ring, ring);
        }
        return id;
      };

      const edges = new Set();
      for (let c = -rings; c <= rings; c++) {
        for (let r = -rings; r <= rings; r++) {
          const cx = c * colW + (r % 2 ? colW / 2 : 0);
          const cy = r * rowH;
          const ring = Math.round(Math.hypot(cx, cy) / (R * 1.5));
          if (ring > rings) continue;
          const loop = [];
          for (let k = 0; k < 6; k++) {
            const th = (Math.PI / 3) * k - Math.PI / 2;
            loop.push(vertex(cx + R * Math.cos(th), cy + R * Math.sin(th), ring));
          }
          for (let k = 0; k < 6; k++) {
            const a = loop[k], b = loop[(k + 1) % 6];
            const ek = a < b ? a + "-" + b : b + "-" + a;
            if (edges.has(ek)) continue;
            edges.add(ek);
            bonds.push({ a, b, ring: Math.max(nodes[a].ring, nodes[b].ring) });
          }
        }
      }
      maxRing = bonds.reduce((m, b) => Math.max(m, b.ring), 1);
      bonds.forEach((b, i) => { nodes[b.a].adj.push(i); nodes[b.b].adj.push(i); });
      carriers = [];
      if (!reduce) for (let i = 0; i < 5; i++) carriers.push(seed());
    }

    function seed() {
      return { bond: (Math.random() * bonds.length) | 0, u: Math.random(),
               dir: Math.random() < 0.5 ? 1 : -1,
               speed: 0.022 + Math.random() * 0.03 };
    }

    /* ---- camera ---------------------------------------------------- */

    function project() {
      const spinAmt = reduce ? 0 : spin;
      const ax = -0.72 + Math.sin(t * 0.0006) * 0.12 * spinAmt;
      const ay = t * 0.00042 * spinAmt;
      const ca = Math.cos(ax), sa = Math.sin(ax);
      const cb = Math.cos(ay), sb = Math.sin(ay);

      for (const n of nodes) {
        const lift = reduce ? 0
          : Math.sin(n.phase + t * 0.0024) * R * 0.85 * spinAmt;
        const y1 = n.y * ca - lift * sa;
        const z1 = n.y * sa + lift * ca;
        const x2 = n.x * cb + z1 * sb;
        const z2 = -n.x * sb + z1 * cb;
        const d = DEPTH + z2;
        // Fit the sheet to the panel. Without this the same world-space
        // lattice that fills a laptop panel showed one sliver on a phone.
        const s = d > 1 ? (FOV * fit) / d : 0;
        n.sx = w / 2 + x2 * s;
        n.sy = h / 2 + y1 * s;
        n.sz = z2;
        n.s = s;
      }
    }

    /* ---- paint ----------------------------------------------------- */

    function paint() {
      ctx.clearRect(0, 0, w, h);
      const acc = HOT, dim = COOL;
      const edge = grown * maxRing;          // how far the sheet has grown

      ctx.lineCap = "round";
      for (const b of bonds) {
        const a = nodes[b.a], c = nodes[b.b];
        if (a.s <= 0 || c.s <= 0) continue;
        const d = edge - b.ring;
        if (d < -0.9) continue;                       // not grown yet

        const depth = Math.max(0, Math.min(1, 1 - (((a.sz + c.sz) / 2) + 180) / 420));
        let alpha, colour, width;
        if (d < 0.9) {
          // the crystallisation front: bright, thick, fading inward
          const front = 1 - Math.abs(d) / 0.9;
          alpha = 0.35 + 0.65 * front;
          colour = acc;
          width = (1.1 + front * 1.9) * ((a.s + c.s) / 2) * 0.55;
        } else {
          alpha = 0.46 + 0.4 * depth;
          colour = dim;
          width = 1.25 * ((a.s + c.s) / 2) * 0.6;
        }
        if (flash > 0) { alpha = Math.min(1, alpha + flash * 0.7); colour = acc; }

        ctx.globalAlpha = alpha;
        ctx.strokeStyle = colour;
        ctx.lineWidth = Math.max(0.6, width);
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(c.sx, c.sy);
        ctx.stroke();
      }

      // carriers, only on bonds that exist
      for (const p of carriers) {
        const b = bonds[p.bond];
        if (!b || b.ring > edge) continue;
        const a = nodes[b.a], c = nodes[b.b];
        if (a.s <= 0 || c.s <= 0) continue;
        const u = p.dir > 0 ? p.u : 1 - p.u;
        const x = a.sx + (c.sx - a.sx) * u, y = a.sy + (c.sy - a.sy) * u;
        const s = (a.s + c.s) / 2;
        const r = Math.max(2.5, s * 5.5);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, GLOW);
        g.addColorStop(1, "transparent");
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      }

      // the seed at the centre keeps a pulse even while a tool is slow
      const beat = reduce ? 0.6 : 0.6 + Math.sin(t * 0.004) * 0.4;
      ctx.globalAlpha = beat;
      ctx.fillStyle = acc;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 2.4 + beat * 1.6, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    /* ---- loop ------------------------------------------------------ */

    function frame(now) {
      if (!running) return;
      t = now;
      grown += (target - grown) * 0.045;
      if (settle) { spin += (0 - spin) * 0.03; }
      if (flash > 0) flash -= 0.02;
      if (!reduce) {
        for (let i = 0; i < carriers.length; i++) {
          const p = carriers[i];
          const b = bonds[p.bond];
          if (!b) { carriers[i] = seed(); continue; }
          p.u += p.speed;
          if (p.u >= 1) {
            const at = p.dir > 0 ? b.b : b.a;
            const opts = nodes[at].adj.filter((x) =>
              x !== p.bond && bonds[x].ring <= grown * maxRing);
            if (!opts.length) { carriers[i] = seed(); continue; }
            const next = opts[(Math.random() * opts.length) | 0];
            p.dir = bonds[next].a === at ? 1 : -1;
            p.bond = next; p.u = 0;
          }
        }
      }
      project(); paint();
      raf = requestAnimationFrame(frame);
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(80, rect.width); h = Math.max(80, rect.height);
      // The sheet is about 9 rings across; size it to whichever edge is tighter.
      fit = Math.max(0.58, Math.min(1.3, Math.min(w / 640, h / 250)));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    resize();
    build();
    raf = requestAnimationFrame(frame);

    return {
      /* One finished step grows the sheet by one ring. Callers pass nothing,
         so the count is kept here rather than demanded of them. */
      step(n) {
        steps = typeof n === "number" ? n : steps + 1;
        target = Math.min(1, 0.34 + steps * 0.11);
      },
      /* The answer arrived: fill the sheet, light it once, come to rest. */
      done() {
        target = 1; settle = 1; flash = 1;
      },
      stop() { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; },
      resize,
    };
  }

  global.ResearchAnim = { create };
})(window);
