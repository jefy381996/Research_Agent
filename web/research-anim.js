/* What the agent looks like while it is working.
 *
 * This used to be a sheet of graphene growing in open space: hexagonal faces
 * with real surface normals taken from a standing wave, rotated against a
 * fixed light, sorted back to front so near cells occluded far ones. It was
 * genuinely three-dimensional and it was beautiful on a desktop.
 *
 * Measured on a throttled phone it issued 433 canvas path operations every
 * frame, ran at 30fps, and missed 97% of its frame budget - and it did that
 * at the one moment the person is already waiting. An animation whose job is
 * to make waiting bearable should not be the reason the wait is slow.
 *
 * What replaced it says more with nothing moving. The steps the agent
 * actually takes are listed as it takes them, and a thin line travels down
 * the left of that list, reaching each step as it is reached. The person
 * waiting learns what is being done and how far it has got, which the sheet
 * never told them.
 *
 * There is no canvas, no loop and no frame budget: appending a row and
 * changing one custom property is the whole of it, and the line moves
 * because CSS transitions a transform.
 */
(function (global) {
  const IDLE = { step() {}, done() {}, stop() {}, resize() {} };

  function create(host, opts) {
    if (!host) return Object.assign({}, IDLE);

    const list = document.createElement("ol");
    list.className = "rsteps";
    const rail = document.createElement("i");
    rail.className = "rrail";
    rail.setAttribute("aria-hidden", "true");
    list.appendChild(rail);

    host.textContent = "";
    host.appendChild(list);

    let rows = [];
    let stopped = false;

    function add(text) {
      const li = document.createElement("li");
      li.className = "rstep is-now";
      li.textContent = text;
      // Entrance is staggered by position, and capped like every other
      // stagger in the stylesheet.
      li.style.setProperty("--i", String(rows.length));
      list.appendChild(li);
      rows.push(li);
      return li;
    }

    /* The line reaches the dot of the current step, not past it: with n
       steps on screen the last dot sits half a row short of the bottom. */
    function reach(full) {
      const n = rows.length;
      const p = full ? 1 : (n ? (n - 0.5) / n : 0);
      list.style.setProperty("--p", p.toFixed(4));
    }

    function settle() {
      for (const li of rows) li.className = "rstep is-done";
    }

    add(opts && opts.first ? opts.first : "Reading the library");
    reach(false);

    return {
      /* Each step the agent finishes becomes a row, and the line follows. */
      step(label) {
        if (stopped) return;
        settle();
        add(typeof label === "string" && label ? label : "Working");
        reach(false);
      },
      done() {
        if (stopped) return;
        settle();
        reach(true);
      },
      stop() {
        stopped = true;
        rows = [];
      },
      resize() {},
    };
  }

  global.ResearchAnim = { create };
})(window);
