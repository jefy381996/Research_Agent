/* What a press looks like.
 *
 * A control that does nothing when it is touched feels broken on a phone,
 * where there is no hover to confirm the press landed. The usual answer is
 * the filled blob that spreads from the finger, which every Android app has
 * had for a decade and which reads as somebody else's design language.
 *
 * This spreads a ring instead: a thin circle of the accent colour, opening
 * outwards from the point of contact and fading as it goes, like charge
 * reaching the edge of a contact. It is one element, it moves by transform
 * and opacity only, and it removes itself when it has finished.
 *
 * It does nothing at all for anyone who has asked for reduced motion.
 */
(function () {
  if (window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  /* Only controls that already clip their own content. A ring needs the
     element to hide what spills past its edge, and forcing that on
     something that deliberately overflows would clip the thing itself. */
  const TOUCHABLE = [
    ".btn", ".chips button", ".excard", ".sitem", ".mode", ".tab",
    ".calc", ".exfilters button", ".src", ".cpaper", ".fi", ".stat",
  ].join(",");

  // A ring is wasted on something too small to see it open.
  const MIN_SIDE = 26;

  function press(ev) {
    // Primary button or touch only: a right-click is not a press.
    if (ev.button !== undefined && ev.button !== 0) return;
    const el = ev.target && ev.target.closest && ev.target.closest(TOUCHABLE);
    if (!el || el.disabled) return;

    const box = el.getBoundingClientRect();
    if (box.width < MIN_SIDE || box.height < MIN_SIDE) return;

    const x = (ev.clientX === undefined ? box.left + box.width / 2 : ev.clientX) - box.left;
    const y = (ev.clientY === undefined ? box.top + box.height / 2 : ev.clientY) - box.top;

    // Big enough to reach the furthest corner from where the finger landed.
    const reach = Math.max(
      Math.hypot(x, y), Math.hypot(box.width - x, y),
      Math.hypot(x, box.height - y), Math.hypot(box.width - x, box.height - y),
    );

    const cs = getComputedStyle(el);
    if (cs.position === "static") el.style.position = "relative";
    if (cs.overflow === "visible") el.style.overflow = "hidden";

    const ring = document.createElement("span");
    ring.className = "rip";
    ring.style.left = x + "px";
    ring.style.top = y + "px";
    ring.style.width = ring.style.height = Math.ceil(reach * 2) + "px";
    ring.addEventListener("animationend", () => ring.remove(), { once: true });
    el.appendChild(ring);
    // A press that somehow never finishes animating must not leave a node
    // behind: the ring is gone either way.
    setTimeout(() => ring.remove(), 900);
  }

  document.addEventListener("pointerdown", press, { passive: true });
})();
