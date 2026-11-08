"""The browser calculators must agree with the Python ones.

The catalogue is generated from Python, so only the arithmetic exists twice.
This runs every calculator in both languages on the same representative inputs
and fails on any disagreement beyond floating-point noise.
"""
import json
import os
import shutil
import subprocess
import unittest

import calculators

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CALC_JS = os.path.join(ROOT, "web", "calc.js")


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class TestCalculatorParity(unittest.TestCase):
    def test_every_calculator_matches_the_browser_implementation(self):
        samples = calculators._SAMPLES
        self.assertEqual(set(samples), set(calculators.REGISTRY),
                         "every calculator needs representative inputs")

        script = (
            f"const {{CALC_FN}} = require({json.dumps(CALC_JS)});\n"
            f"const s = {json.dumps(samples)};\n"
            "const out = {};\n"
            "for (const k of Object.keys(s)) {\n"
            "  try { out[k] = CALC_FN[k] ? CALC_FN[k](s[k]) : 'MISSING'; }\n"
            "  catch (e) { out[k] = 'ERROR ' + e.message; }\n"
            "}\n"
            "process.stdout.write(JSON.stringify(out));\n"
        )
        proc = subprocess.run(["node", "-e", script], capture_output=True,
                              text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        js = json.loads(proc.stdout)

        mismatches = []
        for name, fn in calculators.REGISTRY.items():
            py = fn(**samples[name])["result"]
            got = js.get(name)
            if not isinstance(got, (int, float)):
                mismatches.append(f"{name}: browser said {got!r}")
                continue
            # Python rounds to six decimals on the way out; round the browser
            # value the same way so like is compared with like.
            got = round(got, 6)
            scale = max(abs(py), abs(got), 1e-12)
            if abs(py - got) / scale > 1e-9:
                mismatches.append(f"{name}: python {py!r} vs browser {got!r}")
        self.assertEqual(mismatches, [], "\n".join(mismatches))

    def test_catalogue_covers_every_calculator_with_a_worked_formula(self):
        cat = calculators.catalogue()
        self.assertEqual(len(cat), len(calculators.REGISTRY))
        for entry in cat:
            self.assertTrue(entry["formula"], f"{entry['name']} has no formula")
            self.assertTrue(entry["unit"] != "" or entry["name"] == "n_p_ratio")
            self.assertTrue(entry["inputs"], f"{entry['name']} has no inputs")


if __name__ == "__main__":
    unittest.main()
