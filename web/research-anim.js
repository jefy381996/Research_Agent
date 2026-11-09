/* What the agent looks like while it is working.
 *
 * Graphene is grown, in a reactor, by carbon atoms landing on a surface and
 * locking into a hexagonal lattice ring by ring. That is what this draws: the
 * sheet crystallises outward as the agent completes steps, carriers run along
 * the bonds that exist so far, and the whole thing settles when the answer
 * arrives. Every ring is a real step the agent finished, so the animation is
 * a progress indicator rather than a decoration.
 */
(function (global) {
  const TAU = Math.PI * 2;

  function create(canvas, opts) {
    const reduce = window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { step() {}, done() {}, stop() {} };

    const SIDE = (opts && opts.side) || 20;
    let w = 0, h = 0, cx = 0, cy = 0, dpr = 1;
    let cells = [], carriers = [], raf = 0, t = 0;
    let grown = 1, target = 1, settling = 0, running = true;

    function accent() {
      return getComputedStyle(document.documentElement)
        .getPropertyValue("--acc").trim() || "#E8C27A";
    }
    function faint() {
      return getComputedStyle(document.documentElement)
        .getPropertyValue("--lattice").trim() || "rgba(180,180,180,.2)";
    }

    /* Axial hex coordinates, ring by ring out from the middle. */
    function build() {
      cells = [];
      const R = 6;
      for (let q = -R; q <= R; q++) {
        for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
          const ring = (Math.abs(q) + Math.abs(r) + Math.abs(-q - r)) / 2;
          const x = SIDE * 1.5 * q;
          const y = SIDE * Math.sqrt(3) * (r + q / 2);
          cells.push({ x, y, ring, seed: Math.random() * TAU });
        }
      }
      cells.sort((a, b) => a.ring - b.ring);
    }

    function size() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = Math.max(240, rect.width); h = Math.max(120, rect.height);
      canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx = w / 2; cy = h / 2;
    }

    function hexPath(x, y, s) {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * (60 * i);
        const px = x + s * Math.cos(a), py = y + s * Math.sin(a);
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
    }

    function spawnCarrier() {
      const live = cells.filter((c) => c.ring <= grown);
      if (!live.length) return;
      const c = live[(Math.random() * live.length) | 0];
      carriers.push({ x: c.x, y: c.y, a: Math.random() * TAU, life: 1,
                      speed: 0.9 + Math.random() * 0.9 });
      if (carriers.length > 14) carriers.shift();
    }

    function frame() {
      if (!running) return;
      t += 0.016;
      grown += (target - grown) * 0.06;
      ctx.clearRect(0, 0, w, h);
      ctx.save(); ctx.translate(cx, cy);

      const col = accent(), dim = faint();
      for (const c of cells) {
        const edge = grown - c.ring;
        if (edge < -0.6) continue;
        const appear = Math.max(0, Math.min(1, edge + 0.6));
        const breathe = 0.6 + 0.4 * Math.sin(t * 1.5 + c.seed);
        ctx.globalAlpha = appear * (settling ? 0.5 : 0.28 + breathe * 0.3);
        ctx.lineWidth = edge < 0.5 ? 1.6 : 1;
        ctx.strokeStyle = edge < 0.5 ? col : dim;
        hexPath(c.x, c.y, SIDE * (0.82 + appear * 0.18));
        ctx.stroke();
        if (edge >= 0 && edge < 1.4) {
          ctx.globalAlpha = appear * 0.9 * (1 - edge / 1.4);
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.arc(c.x, c.y, 1.7, 0, TAU); ctx.fill();
        }
      }

      for (let i = carriers.length - 1; i >= 0; i--) {
        const p = carriers[i];
        p.x += Math.cos(p.a) * p.speed; p.y += Math.sin(p.a) * p.speed;
        p.life -= 0.012;
        if (p.life <= 0) { carriers.splice(i, 1); continue; }
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 16);
        g.addColorStop(0, col); g.addColorStop(1, "transparent");
        ctx.globalAlpha = p.life * 0.5;
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, 16, 0, TAU); ctx.fill();
      }

      // the growth front, sweeping outward
      if (!settling) {
        ctx.globalAlpha = 0.25 + 0.15 * Math.sin(t * 2.2);
        ctx.strokeStyle = col; ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(0, 0, grown * SIDE * 1.72, 0, TAU);
        ctx.stroke();
      }

      ctx.restore();
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    }

    build(); size();
    const onResize = () => { size(); };
    window.addEventListener("resize", onResize);

    if (reduce) {                 // one still frame; no motion at all
      target = grown = 4; settling = 1; frame(); running = false;
      cancelAnimationFrame(raf);
    } else {
      const sparks = setInterval(() => running && spawnCarrier(), 420);
      raf = requestAnimationFrame(frame);
      canvas._sparks = sparks;
    }

    return {
      step() { target = Math.min(6, target + 1); for (let i = 0; i < 3; i++) spawnCarrier(); },
      done() { target = 6; settling = 1;
               setTimeout(() => { running = false; cancelAnimationFrame(raf);
                 clearInterval(canvas._sparks);
                 window.removeEventListener("resize", onResize); }, 900); },
      stop() { running = false; cancelAnimationFrame(raf);
               clearInterval(canvas._sparks);
               window.removeEventListener("resize", onResize); },
    };
  }

  global.ResearchAnim = { create };
})(window);
