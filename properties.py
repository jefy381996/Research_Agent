"""The properties graphene is actually famous for, and the bounds they live in.

The battery extractor answers "how much charge does this electrode hold".
A researcher asking about graphene will as often want the thermal conductivity,
the sheet resistance, the modulus or the surface area, and those numbers sit in
the same abstracts in the same form: a figure and a unit, in one sentence.

Each entry here is one property family. `patterns` are tried in order against a
normalised sentence; the first that matches wins. `scale` converts a matched
unit to the family's canonical unit, so 1 TPa and 1000 GPa become one number
that can be ranked. `low` and `high` are the range a real measurement falls in;
anything outside is kept but flagged, never dropped, because a flagged number a
reader can see beats a number quietly deleted.

The bounds are deliberately wide. They are there to catch a parse that went
wrong - a page number read as a modulus - not to rule on whether a result is
believable. That judgement belongs to the reader.
"""

from __future__ import annotations

# A figure as a paper writes it. Thousands are grouped with a comma, a space
# or nothing at all - "280,000", "68 000", "68000" - and a space-grouped figure
# cost ten real measurements before it was handled: "68 000" matched "000".
NUM = (r"(\d{1,4}(?:[,\s]\d{3})*(?:\.\d+)?"
       r"(?:\s*[x\u00d7]\s*10\s*-?\s*\d+)?)"
       # An uncertainty is not a value: "670 +- 5 L m-2 h-1 bar-1" stored 5,
       # because 5 is the number nearest the unit. Swallowing the "+- 5"
       # makes 670 the leftmost match, so the figure read is the one the
       # paper reported.
       r"(?:\s*(?:\u00b1|\+\s*/?\s*-)\s*\d+(?:[.,]\d+)?)?")


def _n(raw: str) -> float | None:
    """A matched figure as a number, including 1.5 x 10 4 scientific form."""
    import re
    raw = raw.strip()
    sci = re.match(r"^(.+?)\s*[x\u00d7]\s*10\s*(-?)\s*(\d+)$", raw)
    try:
        if sci:
            base = _n(sci.group(1))
            if base is None:
                return None
            exp = int(sci.group(3)) * (-1 if sci.group(2) else 1)
            return base * (10 ** exp)
        # A lone comma with two decimals is a decimal point ("1,5 V"); any
        # other comma, and every space, is a thousands separator.
        if raw.count(",") == 1 and len(raw.split(",")[-1]) != 3:
            raw = raw.replace(",", ".")
        return float(re.sub(r"[,\s]", "", raw))
    except ValueError:
        return None


# unit alternatives written once, because every family repeats the same noise:
# an optional per sign, optional spacing, optional -1 exponent.
PER = r"\s*(?:/|per|\s)\s*"
E1 = r"(?:\s*-\s*1)?"
E2 = r"(?:\s*-\s*2)?"

FAMILIES = [
    {
        "key": "thermal_conductivity",
        "label": "Thermal conductivity",
        "unit": "W/mK",
        "aliases": ["thermal conductivity", "heat conduction", "thermal transport"],
        "low": 0.005, "high": 6000,
        "patterns": [
            (NUM + r"\s*W" + PER + r"\(?\s*m\s*[.\-]?\s*K\s*\)?" + E1, 1.0),
            (NUM + r"\s*W\s*m" + E1 + r"\s*K" + E1, 1.0),
            (NUM + r"\s*W" + PER + r"mK", 1.0),
            (NUM + r"\s*W" + PER + r"\(?\s*c\s*m\s*[.\-]?\s*K\s*\)?" + E1, 100.0),
        ],
    },
    {
        # Electronic conduction through the material itself.
        "key": "electrical_conductivity",
        "shares_unit_with": "siemens",
        "label": "Electrical conductivity",
        "unit": "S/m",
        "aliases": ["electrical conductivity", "electric conductivity",
                    "electronic conductivity"],
        "low": 1e-8, "high": 1e9,
        "patterns": [
            (NUM + r"\s*S" + PER + r"c\s?m" + E1, 100.0),
            (NUM + r"\s*S" + PER + r"m" + E1 + r"(?![a-z])", 1.0),
            (NUM + r"\s*S\s*c\s?m" + E1, 100.0),
        ],
        "needs_alias": True,
    },
    {
        # Ion transport through an electrolyte or membrane. Same unit, a
        # different quantity entirely, and mixing the two made the first run
        # rank a polymer electrolyte against a graphene film.
        "key": "ionic_conductivity",
        "shares_unit_with": "siemens",
        "label": "Ionic conductivity",
        "unit": "S/m",
        "aliases": ["ionic conductivity", "ion conductivity",
                    "lithium-ion conductivity", "proton conductivity"],
        "low": 1e-10, "high": 1e4,
        "patterns": [
            (NUM + r"\s*S" + PER + r"c\s?m" + E1, 100.0),
            (NUM + r"\s*S" + PER + r"m" + E1 + r"(?![a-z])", 1.0),
            (NUM + r"\s*S\s*c\s?m" + E1, 100.0),
        ],
        "needs_alias": True,
    },
    {
        "key": "sheet_resistance",
        "label": "Sheet resistance",
        "unit": "ohm/sq",
        "aliases": ["sheet resistance", "surface resistance", "square resistance"],
        "low": 0.01, "high": 1e9,
        "patterns": [
            (NUM + r"\s*(?:Ω|ohm|ohms|Ohm)" + PER + r"(?:sq\.?(?:uare)?|□|sheet)", 1.0),
            (NUM + r"\s*(?:Ω|ohm|ohms|Ohm)\s*sq" + E1, 1.0),
            (NUM + r"\s*(?:Ω|ohm|ohms|Ohm)" + PER + r"□", 1.0),
        ],
    },
    {
        "key": "carrier_mobility",
        "label": "Carrier mobility",
        "unit": "cm2/Vs",
        "aliases": ["carrier mobility", "electron mobility", "hole mobility",
                    "field-effect mobility", "mobility of"],
        "low": 1e-4, "high": 1_000_000,
        "patterns": [
            (NUM + r"\s*cm\s*2" + PER + r"\(?\s*V\s*[.\-]?\s*s\s*\)?" + E1, 1.0),
            (NUM + r"\s*cm\s*2\s*V" + E1 + r"\s*s" + E1, 1.0),
        ],
    },
    {
        "key": "youngs_modulus",
        "shares_unit_with": "pascal",
        "label": "Young's modulus",
        "unit": "GPa",
        "aliases": ["young's modulus", "youngs modulus", "elastic modulus",
                    "tensile modulus", "stiffness"],
        "low": 1e-4, "high": 2000,
        "patterns": [
            (NUM + r"\s*TPa", 1000.0),
            (NUM + r"\s*GPa", 1.0),
            (NUM + r"\s*MPa", 0.001),
        ],
        "needs_alias": True,
    },
    {
        "key": "tensile_strength",
        "shares_unit_with": "pascal",
        "label": "Tensile strength",
        "unit": "MPa",
        "aliases": ["tensile strength", "fracture strength", "breaking strength",
                    "ultimate strength", "mechanical strength"],
        "low": 0.01, "high": 200_000,
        "patterns": [
            (NUM + r"\s*GPa", 1000.0),
            (NUM + r"\s*MPa", 1.0),
        ],
        "needs_alias": True,
    },
    {
        "key": "surface_area",
        "label": "Specific surface area",
        "unit": "m2/g",
        "aliases": ["surface area", "bet area", "specific area"],
        "low": 0.1, "high": 4000,
        "patterns": [
            # Lowercase, case-sensitively: m2/g is an area per gram, while
            # "Au 4 M 2 /G" is a chemical formula and 2 M is a molarity.
            # Compiled case-insensitively with the rest, "4 M 2 /G" came back
            # as four square metres per gram.
            (NUM + r"\s*(?-i:m)\s*2" + PER + r"(?-i:g)" + E1 + r"(?![a-z])", 1.0),
            (NUM + r"\s*(?-i:m)\s*2\s*(?-i:g)" + E1, 1.0),
        ],
    },
    {
        "key": "capacitance",
        "label": "Specific capacitance",
        "unit": "F/g",
        "aliases": ["specific capacitance", "capacitance", "supercapacitor"],
        "low": 0.1, "high": 5000,
        "patterns": [
            # (?-i:F) insists on the capital. These patterns are compiled
            # case-insensitively with the rest, and without this a
            # biosensor's "1 fg/mL" - one femtogram per millilitre - reads
            # as one farad per gram. Papers do write "292 Fg-1" with no
            # separator, so the separator cannot be what distinguishes them;
            # the case can, and SI spelling is what journals enforce.
            (NUM + r"\s*(?-i:F)" + PER + r"g" + E1 + r"(?![a-z])", 1.0),
            (NUM + r"\s*(?-i:F)\s*g" + E1, 1.0),
            (NUM + r"\s*(?-i:mF)" + PER + r"c?m\s*2", None),  # areal: other unit
        ],
    },
    {
        "key": "transmittance",
        "label": "Optical transmittance",
        "unit": "%",
        "aliases": ["transmittance", "transparency", "optical transmission"],
        "low": 0.1, "high": 100,
        "patterns": [(NUM + r"\s*%", 1.0)],
        "needs_alias": True,
    },
    {
        "key": "water_permeance",
        "label": "Water permeance",
        "unit": "L/m2/h/bar",
        "aliases": ["permeance", "water flux", "permeability", "water permeation"],
        "low": 0.001, "high": 1_000_000,
        "patterns": [
            (NUM + r"\s*L\s*m" + E2 + r"\s*h" + E1 + r"\s*bar" + E1, 1.0),
            (NUM + r"\s*L" + PER + r"\(?\s*m\s*2\s*h\s*bar\s*\)?", 1.0),
            (NUM + r"\s*LMH" + PER + r"bar", 1.0),
        ],
    },
    {
        "key": "emi_shielding",
        "label": "EMI shielding effectiveness",
        "unit": "dB",
        "aliases": ["shielding effectiveness", "emi shielding", "electromagnetic "
                    "interference", "shielding"],
        "low": 0.1, "high": 200,
        # "dB cm2 g-1" is specific shielding effectiveness: the same figure
        # divided by density and thickness, and a hundred times larger. It is
        # a different quantity, so the unit must end at dB.
        "patterns": [(NUM + r"\s*dB(?!\s*[.\u00b7/]?\s*(?:c?m|g|kg|per|/))", 1.0)],
        "needs_alias": True,
    },
]

BY_KEY = {f["key"]: f for f in FAMILIES}


def catalogue() -> list[dict]:
    """What the library can answer about, for the interface and the agent."""
    return [{"key": f["key"], "label": f["label"], "unit": f["unit"],
             "aliases": f["aliases"], "range": [f["low"], f["high"]]}
            for f in FAMILIES]
