# Graphene Research Agent

A research workbench for graphene — batteries, electronics, sensors, membranes,
composites, coatings, thermal transport, photonics, catalysis, biomedicine,
toxicity and production. It answers from stored data and nothing else:
reference entries for the fundamentals, measurements pulled out of published
papers, and calculators you can audit.

**285 reference entries · 4,745 measurements · 37,027 papers · 34 compounds ·
28 calculators.** The measurements come in two halves: 2,794 battery
performance figures — capacity, retention, cycle life, rate, efficiency — and
1,951 material properties across twelve families, from thermal conductivity and
sheet resistance to Young's modulus, surface area, optical transmittance, water
permeance and EMI shielding. Two ways to ask. **Instant** runs on rules alone: no model,
no network, the same answer every time. **Agent** gives a language model
fifteen tools over the same data, checks every number and every citation it
produces against what the tools actually returned, and makes it correct itself
once before you see the answer.

The two hand over to each other, and the test is whether the shape of the
answer matches the shape of the question rather than whether Instant refused.
Instant almost never refuses: asked *why* silicon anodes crack it returns a
table of capacities, and asked *how much* graphene strengthens epoxy it returns
quoted prose with no figure in it. Both look like answers. Neither is one, and
both now go to the agent, as does a question about which option is better.

Any answer that comes back as quoted passages goes too, whatever was asked.
That branch exists for when the rules found nothing to extract, and it says so
on screen — "No comparable numbers were extracted for this question" — so it is
Instant reporting its own failure, and the agent reads the same papers and
writes the answer out of them. The toggle follows whichever engine is actually
running, rather than the one that was picked.

A researcher's own data sits between the two. The order is: the library,
then whatever they have added, then the agent — each step running only because
the one before it came up short. Their figures also appear *beside* a library
answer whenever both have something to say, in their own frame with their own
count, never blended into the median.

That matching is deliberately conservative. The question has to agree with the
row on subject — the material, the chemistry, the property — not merely share
a word with it. An early version counted any two matching words and attached a
researcher's zirconium run to a question about silicon anodes, because they
shared "capacity", "anode" and a graphene form. A researcher who sees their own
result against somebody else's question stops trusting the screen, which costs
more than a missed match.

Going the other way, when the agent cannot run - no key, no quota, or a
question it has not researched - Instant answers instead, and the agent's
working stays on screen if it got far enough to show any.

Three guards keep this from running away. A handed-over run never hands back,
so a question costs at most one attempt from each engine. A question refused as
outside the remit is never escalated: advice, prices, predictions and creative
writing are decisions the agent is held to as well, not misses. And a question
that matched nothing is escalated only when it touches the subject, which is
modelled from the paper titles themselves: 37,000 of them, written by the field
about itself. A tax question or a football result stops at the first refusal
instead of spending a model call to reach the same answer, while a question
about tungsten does go to the agent, because the corpus holds *Atomic Tungsten
on Graphene* and the agent should look.

## Run it

```bash
pip install -r requirements.txt
```

```bash
cp .env.example .env    # then add your OpenAlex key
```

```bash
python collect_papers.py --out data/papers.csv
```

```bash
python load_papers.py && python extract_evidence.py && python build_index.py
```

```bash
python -m uvicorn api:app --port 8000
```

Open <http://localhost:8000>. The database ships with the repository, so to
look at the interface only, the last command is the one you need.

```bash
python -m unittest discover -s tests && python scorecard.py
```

## A shareable link, with nothing to deploy

`build_demo.py` writes a static mirror into `demo/`: the same interface and the
same data, with the evidence table and the stored abstracts embedded so the
page needs no backend. Filtering, the source drawer, asking, refusing and CSV
export all work. Uploading your own PDF is the one feature it cannot offer,
because that needs the running service.

```bash
python build_demo.py && python -m http.server 8001 --directory demo
```

A published copy is at <https://claude.ai/artifact/QuP8gNZpF5guDB4NvsjFoW>. It
is private until it is shared from the page's Share menu, so share it before
sending the link to anyone.

## Where the data comes from

| Source | What it gives | Licence |
|---|---|---|
| [OpenAlex](https://openalex.org) | 37,027 paper records and abstracts, 2019 onward | CC0 |
| [Wikipedia](https://en.wikipedia.org) | 285 reference entries across 19 categories, stored verbatim with a link to each original | CC BY-SA 4.0 |
| [PubChem](https://pubchem.ncbi.nlm.nih.gov) | 34 compounds: formula, mass, structure | public domain |
| This repository | 4,745 measurements extracted from the abstracts (2,794 battery, 1,951 material property), and 28 calculators | the repository's licence |

All of it is open and checkable. Nothing is paid for, and nothing is behind a
login. Every reference entry shows which source it came from and links to it,
so a reader can go and disagree with it.

## How it works

| Stage | Script | What it does |
|---|---|---|
| Collect papers | `collect_papers.py` | 42 title-anchored OpenAlex searches across applications, fundamentals and characterisation, unioned and de-duplicated on the work id |
| Collect knowledge | `collect_knowledge.py` | Reference entries from Wikipedia and compound data from PubChem, paced and retried |
| Load | `load_papers.py` | CSV into SQLite, matched on the work id |
| Full text | `fetch_text.py` | Downloads, extracts and **deletes** PDFs for papers whose licence permits it |
| Extract | `extract_evidence.py` | Reads battery performance figures out of sentences |
| Extract | `extract_properties.py` | Reads the twelve material-property families out of the same sentences (`properties.py` holds the units and bounds) |
| Check | `plausibility.py` | Physical bounds, internal arithmetic, group outliers, unit sanity |
| Index | `build_index.py` | 500-word chunks with 50-word overlap, FTS5 |
| Search | `search.py` | BM25 with domain synonym expansion. No AI in this file |
| Answer | `answer.py` | Quantitative synthesis with citations, or refusal |
| Serve | `api.py` | The API and the interface, as one deployable unit |

The agent adds five more files, used only when **Agent** mode is on:

| Part | File | What it does |
|---|---|---|
| Provider | `llm.py` | One interface over Groq, OpenAI, Anthropic and Gemini. Switching provider is one environment variable |
| Tools | `agent_tools.py` | Fifteen read-only tools over the same database. Every limit is clamped server-side, and `sql_query` accepts a single read-only `SELECT` on a read-only connection |
| Sandbox | `sandbox.py` | Runs analysis the agent writes itself, under CPU, memory, file-size and process limits, in its own session, as an unprivileged user, with no keys in the environment |
| Loop | `agent.py` | Plans, calls tools, then checks its own answer: every number must appear in a tool result and every citation must be an id a tool issued. One round of self-correction, then the unsupported sentences are struck |
| Cache | `agent_cache.py` | Stores whole runs keyed on the question, provider and model, so a demo question replays instantly and identically. A run containing an error is never cached |

Every script is safe to re-run. A failure on one paper never stops a run, and
every run writes to `run_log`.

## Why extraction is deterministic

Each row is scoped to **a single sentence**. A row exists only when that
sentence states a capacity or a retention figure, and every other number in
the row is read from the same sentence. Two consequences follow by
construction rather than by audit:

- every number carries the sentence it came from, because that is where it was
  found;
- a row is internally coherent, because its numbers were reported together.

Text verification still runs over every row and the full table is tested for
it, so the rule is enforced rather than assumed. A unit conversion is treated
as a derivation, not an extraction: a value converted from A/g to mA/g is
checked against the as-reported string it came from, and the interface shows
both.

Nothing is inferred. Two capacities in one sentence are usually a rate
comparison at two currents, not a start and an end, so an initial capacity is
recorded only where the sentence states the pair. A capacity introduced as a
theoretical limit is not stored as a measurement.

An LLM pass is available behind `LLM_PROVIDER`, and may only rephrase text
already retrieved. It cannot introduce a fact. The default path needs no model,
no key and no network, and returns the same answer every time.

## Asking out loud

There is a microphone beside the Ask button and a hands-free switch beside it.
Speak a question, watch the transcript appear, hear the answer, and be listened
to again. All of it runs in the browser through the Web Speech API, so it needs
no key, no quota and no per-minute charge — which matters, because the engine
it is wired to needs no model either. Instant answers by rule in under a
second, so the whole loop is free and unlimited.

What a paid realtime model would add is interruption mid-sentence. That is
approximated rather than bought: the recogniser keeps running while the answer
is spoken, and the moment you start talking the speech is cut off and your
words are taken instead.

Three parts do the work that is not audio, and they are the ones with tests:

| Part | Problem it solves |
|---|---|
| `sayable()` | A screen reads `1,842 mAh/g`; a person says "one thousand eight hundred and forty two milliamp hours per gram". Citation markers, markdown and table pipes never reach the voice |
| `fixTerms()` | A recogniser hears "are gee oh" and the library calls it `rGO`. Also "lithium sulphur", "see rate", "c v d", "graphine" |
| `parseCommand()` | "Show me the measurements" is an instruction; "what capacity do silicon anodes reach" is a question. Telling them apart, and never mistaking one for the other |

Each kind of answer has a spoken form of one or two sentences, because a screen
can hold sixty cards and an ear cannot. The written answer with its citations
stays on screen throughout: speech is the way in and the way out, never the
record, because a spoken number cannot be clicked to see the sentence it came
from.

Two limits, said in the interface rather than left to be found. Listening does
not exist in Firefox at all, so the button is disabled there with the reason on
it; speaking works everywhere. And in Chrome the audio goes to Google's
recogniser — free, but not local, which is worth saying plainly in an app whose
other promise is that your own data never leaves the browser.

## A researcher's own data

A researcher can read their own results with the same two extractors the
library was built with: paste a results paragraph, or drop a PDF. The figures
come back under the same rule — one sentence per figure, and that sentence
travels with it — and appear as cards that open to show it, exactly as library
measurements do.

**The server stores none of it.** It extracts and returns; the rows live in the
browser that asked for them. This deployment has no login, so anything written
to the database would be readable by everyone holding the link, and unpublished
results are precisely what a researcher would be adding. `/api/extract/text`
and `/api/extract/pdf` write nothing, no PDF is retained, and
`tests/test_user_data.py` compares every table's row count across a call to
prove it.

That also keeps the library honest. A figure somebody supplied can never be
counted as published evidence, because it was never stored to be counted — the
totals do not move, and every supplied row is tagged *yours* wherever it
appears. The cost is stated on the screen: the data does not follow the
researcher to another browser, so there is a CSV export.

The agent does not see this data yet. Instant mode and the Measurements and
Properties screens do.

## Properties, and why they needed their own rules

A battery figure is unambiguous: `372 mAh/g` can only be a capacity. A material
property often is not. `5 GPa` is a modulus or a strength depending on the
words around it, `97%` is a transmittance only if the sentence says so, and
`S/cm` is electronic conduction through a film or ionic conduction through an
electrolyte — two different quantities sharing a unit.

So families with a unit of their own (W/mK, Ω/sq, cm²/V·s, m²/g, F/g,
L m⁻² h⁻¹ bar⁻¹) are matched on the unit alone. The rest must name the property
in the same sentence, and the figure taken is the one nearest that mention. When
a sentence names two properties that *share* a unit, neither is taken: there is
nothing in the text that says which figure belongs to which. A sentence naming a
strength and a conductivity still yields both, because those cannot be confused.

Three further distinctions, each added after the extractor got one wrong:

- **`dB` must end at `dB`.** `20906 dB cm² g⁻¹` is specific shielding
  effectiveness — the same figure divided by density and thickness, and a
  hundred times larger. Read as plain dB it put an impossible number at the top
  of the table.
- **Space-grouped thousands are one number.** `68 000 cm² V⁻¹ s⁻¹` matched
  `000` and stored a carrier mobility of zero.
- **A modelling word has to be near the figure.** "Theoretical calculations
  confirmed…" at the start of a long sentence does not make a capacitance
  measured at the end of it a simulation. The flag now needs the word within
  ninety characters of the number.

Known values come back out: graphene's thermal conductivity peaks near
5,300 W/mK, its Young's modulus near 1 TPa, its transmittance at 97.7%, and
carrier mobility reaches 250,000 cm² V⁻¹ s⁻¹ in encapsulated devices. Those are
in the test suite, so if they stop appearing something upstream has broken.

Medians, though, sit far below those peaks — thermal conductivity's median is
about 10 W/mK — because most papers measure graphene *in* something: a polymer,
a composite, a film. That is not an error. It is why the interface groups by
application before it compares.

## What the checks cover, and what they cannot

Covered: capacity above 5,000 mAh/g, retention above 100%, cycle counts above
100,000, temperatures outside −40 to 200 °C, voltage windows outside 0–5 V,
first-cycle efficiency above 100%, retention arithmetic that does not match its
own start and end values, group outliers beyond 3.5 robust sigma, and
magnitudes that suggest an F/g value read as mAh/g.

**Not covered.** These checks cannot tell whether a plausible number was
measured under the conditions a row claims. They cannot catch a paper that is
itself wrong. They cannot judge whether a comparison is scientifically fair.
No battery chemist has reviewed this data. Every row carries `verified`,
`flagged` or `unverified`, flagged rows are visible from the filter rail rather
than hidden, and each one says why it was flagged.

## What it answers

Six shapes of question, decided by rules rather than by a model:

| Ask | Example | What comes back |
|---|---|---|
| A definition | *What is graphene?* | The reference entry, its source, and papers and measurements that touch it — and, where the library also measures the term, its median and spread |
| A material property | *What thermal conductivity do graphene composites reach?* | Median and spread in the property's own unit, grouped by what it was measured on, with the sentence behind each figure |
| A number | *What capacity do silicon graphene anodes reach?* | The median and spread across matching measurements, a distribution chart, and the sentence behind each figure |
| A comparison | *Compare material systems on capacity* | Ranked medians per material system |
| A trend | *How has capacity changed by year?* | Median by publication year |
| A calculation | *1200 mAh/g at 3.7 V, what energy density?* | The formula, the inputs, the result, and where it sits against the library |

Anything else is refused, and it says what it searched.

## Asking questions

The answering engine reports the spread of real measurements and cites the
sentence behind each one. When retrieval is thin it says what it searched and
what it could not find, and stops. It will not answer from outside the stored
papers, and it declines questions about advice, prices, companies and
predictions, which measurements cannot answer however well the words match.

Two scorecards run in CI, because the API and the interface each have an
engine and only one of them is what a visitor meets:

- `scorecard.py` — 30 fixed questions against the API's engine, 15 that must be
  answered and 15 that must be refused.
- `tests/scorecard_ui.js` — 34 questions driven through the real page in a real
  browser, covering definitions, battery numbers, material properties,
  comparisons, trends, calculations, quoted passages and refusals.
- `tests/voice_ui.js` — 50 cases over what is spoken, what is heard and what
  counts as a command. The audio itself cannot be tested in a headless browser;
  everything either side of it can, and that is where the mistakes are.
- `tests/mydata_ui.js` — 19 cases covering a researcher's own data, including
  the two that matter: the library's totals must not move, and a second browser
  must see nothing of the first one's unpublished work.
- `tests/handoff_ui.js` — 31 cases covering which engine answers when: which
  near misses are handed over, which good answers are left alone, that the
  toggle follows the engine that is running, and the guards — out-of-remit and
  off-subject questions must not be escalated, and a handed-over run must never
  hand back.

Both fail the build on drift in either direction.

### Where the lines are drawn

Three rules stop the tool answering questions it only appears to cover, each
added after it got one wrong:

- **Whole-word matching.** "The melting point of tungsten" once matched the
  entry for tin, because *tin* sits inside *mel**tin**g*.
- **Proximity.** Terms must appear near each other, not merely somewhere in the
  same abstract. A paper can mention nuclear magnetic resonance in one sentence
  and a CVD reactor in another without being about nuclear reactors.
- **A coverage floor.** A term must appear in at least 0.8% of passages before
  the library claims to cover it. *Nuclear* and *reactor* appear in under half
  a percent; *separator* and *Raman* in several percent.

## CSV columns

`data/papers.csv` is the collected corpus.

| Column | Meaning |
|---|---|
| `openalex_id` | OpenAlex work id. The primary key, and the de-duplication key |
| `doi` | DOI without the resolver prefix. Empty for 63 of these works |
| `title`, `year`, `publication_date` | As recorded by OpenAlex |
| `journal`, `publisher` | Primary location |
| `authors` | Up to 20 names, `; ` separated, then `et al.` |
| `cited_by_count` | Citations recorded at collection time |
| `citations_per_year` | `cited_by_count / (current year − publication year + 1)` |
| `is_oa`, `oa_status` | Open access state: gold, green, hybrid, bronze, diamond, closed |
| `licence` | OpenAlex licence string, empty where none is recorded |
| `full_text_reusable` | `yes` for CC BY, CC BY-SA, CC0 and public domain; `restricted` for NC and ND terms; `unknown` for open access with no stated licence; `no` for closed. A lead, not legal clearance |
| `pdf_url`, `landing_page_url` | Best open-access location |
| `abstract` | Rebuilt from OpenAlex's inverted index. Empty for 3,303 works |
| `is_preprint` | `no` throughout this corpus |
| `source_queries` | Which of the ten searches found this paper, `\|` separated |
| `retrieved_at` | UTC timestamp of collection |

`data/scorecard.csv` records each fixed question, whether it was answered or
refused, and whether that matched the expectation.

The evidence columns are documented in the schema in `db.py` and in the
"How to read this" sheet of any Excel export.

## Deliberate departures from the brief

Three, each made for a one-week delivery with no second chance at the demo.

1. **SQLite with FTS5, not Neon Postgres with pgvector.** The corpus is a few
   thousand papers, the database is a single file that ships with the
   repository, and the product deploys as one unit rather than three. The
   schema in `db.py` mirrors the specified Postgres design, so the move is a
   port of one file.
2. **A deterministic extractor rather than Gemini.** It makes the
   source-sentence rule true by construction, gives the same answer on every
   run, and removes a network dependency and an API key from the critical
   path. The LLM hook remains, behind one environment variable, as specified.
3. **One FastAPI service serving the interface, not Next.js on a second
   origin.** No build step, no second deployment, and the design direction is
   met directly rather than by overriding a component library's defaults.

Deferred work, and the reasoning behind each deferral, is in `TODO.md`.

## Secrets

Keys live in `.env`, which is git-ignored, and in GitHub Secrets. No key
appears in the code, in a commit, in the workflow file, or in any output.

To add the OpenAlex key for the weekly refresh: open the repository on GitHub,
then **Settings** → **Secrets and variables** → **Actions** → **New repository
secret**. Name it `OPENALEX_API_KEY`, paste the key as the value, and save.
Add `MP_API_KEY` the same way if you want Materials Project reference data. The
workflow reads both from the environment and never writes them anywhere.

## Weekly refresh

`.github/workflows/collect.yml` runs at 03:00 UTC every Sunday, and on demand
from the Actions tab. It runs the whole chain, then the tests and the
scorecard, and commits the refreshed data only if it actually changed. If any
step fails, or the collection returns fewer than 3,000 papers, or the evidence
table holds fewer than 800 rows, the run fails and commits nothing.
