"""One motion rule, enforced.

The stylesheet had four easing curves, thirty-seven distinct durations, and
entrance animations with uncapped staggers - fifty-one cards times twenty-six
milliseconds meant the last card began moving one and a third seconds after
the screen appeared, and on a throttled phone a quarter of frames arrived
late. Two keyframes animated properties that force the page to be laid out
or repainted on every frame: a number's letter-spacing and a highlight's
box-shadow.

None of that is visible in a screenshot and all of it is cheap to reintroduce
one declaration at a time, so it is checked here instead of remembered.
"""
import os
import re
import unittest

CSS = os.path.join(os.path.dirname(__file__), "..", "web", "app.css")

# A screen can change these two without laying the page out or repainting it.
COMPOSITED = {"transform", "opacity"}

# Progressive line drawing has no transform equivalent: the dash offset IS
# the drawing. It runs once per chart, over one path, and is the only
# exception in the file.
KEYFRAME_EXCEPTIONS = {"draw": {"stroke-dashoffset"}}

# Ambient loops keep their own long periods on purpose: they are texture, not
# a response to anything the reader did.
AMBIENT = ("infinite", "lat-drift")

DECL = re.compile(r"(?:animation|transition)(?:-duration|-delay)?\s*:")
RAW_TIME = re.compile(r"(?<![\w.-])(\d*\.?\d+)(ms|s)(?![\w-])")


def read():
    with open(CSS, encoding="utf-8") as fh:
        return fh.read()


def blocks_matching(css, needle):
    """Every at-rule whose condition contains `needle`, body included.

    Counted rather than matched with a pattern: these blocks hold nested
    rules, and a pattern that allows nesting will happily skip over the
    very declaration being looked for.
    """
    out = []
    for m in re.finditer(r"@media\s*\(?[^{]*" + re.escape(needle) + r"[^{]*\{", css):
        depth, i = 1, m.end()
        while i < len(css) and depth:
            if css[i] == "{":
                depth += 1
            elif css[i] == "}":
                depth -= 1
            i += 1
        out.append(css[m.end():i - 1])
    return out


def keyframes(css):
    for m in re.finditer(r"@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}", css):
        yield m.group(1), set(re.findall(r"([a-z-]+)\s*:", m.group(2)))


class TestMotionRule(unittest.TestCase):
    def setUp(self):
        self.css = read()

    def test_keyframes_move_only_transform_and_opacity(self):
        """Animating letter-spacing lays out the line sixty times a second."""
        offenders = []
        for name, props in keyframes(self.css):
            allowed = COMPOSITED | KEYFRAME_EXCEPTIONS.get(name, set())
            extra = props - allowed
            if extra:
                offenders.append((name, sorted(extra)))
        self.assertEqual(offenders, [], f"keyframes touching layout or paint: {offenders}")

    def test_durations_come_from_the_three_tokens(self):
        """A duration written by hand is a duration nobody can retune."""
        offenders = []
        for n, line in enumerate(self.css.split("\n"), 1):
            if any(a in line for a in AMBIENT) or not DECL.search(line):
                continue
            for value, unit in RAW_TIME.findall(line):
                if float(value) == 0:        # 0s means "do not transition"
                    continue
                offenders.append((n, line.strip()))
                break
        self.assertEqual(offenders, [], f"hand-written durations: {offenders}")

    def test_every_stagger_is_capped(self):
        """Fifty cards must not cost fifty steps of delay."""
        uncapped = []
        for n, line in enumerate(self.css.split("\n"), 1):
            if "animation-delay" not in line or "var(--i" not in line and "var(--g" not in line \
                    and "var(--n" not in line:
                continue
            if "min(" not in line:
                uncapped.append((n, line.strip()))
        self.assertEqual(uncapped, [], f"uncapped staggers: {uncapped}")

    def test_only_two_easing_curves(self):
        """Four curves is four different ideas of how the product moves."""
        curves = set(re.findall(r"--e-[\w-]+\s*:\s*([^;}]+)", self.css))
        self.assertLessEqual(len(curves), 2, f"easing curves defined: {sorted(curves)}")
        self.assertNotIn("--e-spring", self.css, "the spring curve is gone; do not reintroduce it")

    def test_anything_animated_open_is_open_without_animation(self):
        """Reduced motion must not leave a folded element folded for good.

        The highlight behind a quoted figure starts at scaleX(0) and is
        unfolded by its animation. Switch animation off and, without an
        explicit override, the strip stays invisible - so the reader who
        asked for less motion is the one who loses the highlight.
        """
        # Only rules unfolded by an animation. An element folded until it is
        # hovered is unfolded by a transition, and switching transitions off
        # simply makes it snap - which is what someone asking for less motion
        # wants.
        folded = [
            sel for sel, body in re.findall(r"([^{}]+)\{([^{}]*transform:\s*scaleX\(0\)[^{}]*)\}",
                                            self.css)
            if "animation:" in body
        ]
        self.assertTrue(folded, "expected at least one element that starts folded")

        reduced = "".join(blocks_matching(self.css, "prefers-reduced-motion:reduce"))
        self.assertIn("scaleX(1)!important", reduced,
                      "no reduced-motion override restores a folded element")
        for selector in folded:
            for one in selector.split(","):
                one = one.strip()
                if not one:
                    continue
                self.assertIn(one, reduced,
                              f"{one} starts folded and nothing unfolds it "
                              f"when motion is switched off")

    def test_blur_layers_stay_few(self):
        """Each backdrop-filter is a separate layer the device must blur.

        Nineteen of the twenty-two on the measurements screen were the cells
        of one sticky table header.
        """
        count = len(re.findall(r"(?<!-)backdrop-filter\s*:\s*(?!none)", self.css))
        self.assertLessEqual(count, 3, "more surfaces are blurring than the two that float")


if __name__ == "__main__":
    unittest.main()
