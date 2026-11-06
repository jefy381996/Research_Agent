# Graphene Battery Evidence Workbench

Researchers cannot compare performance numbers across papers today, because
every paper reports under different conditions and in different units. This
tool collects those numbers from the graphene battery literature, makes them
comparable, and shows the exact sentence each one came from.

**1,849 measurements, from 6,575 papers published 2019 onward.** Every stored
number is attached to the sentence that states it. An empty cell means the
paper did not report that value; nothing is estimated, averaged, or converted
from a figure a paper did not give.

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

## How it works

| Stage | Script | What it does |
|---|---|---|
| Collect | `collect_papers.py` | Ten title-anchored OpenAlex searches, unioned and de-duplicated on the work id |
| Load | `load_papers.py` | CSV into SQLite, matched on the work id |
| Full text | `fetch_text.py` | Downloads, extracts and **deletes** PDFs for papers whose licence permits it |
| Extract | `extract_evidence.py` | Reads measurements out of sentences |
| Check | `plausibility.py` | Physical bounds, internal arithmetic, group outliers, unit sanity |
| Index | `build_index.py` | 500-word chunks with 50-word overlap, FTS5 |
| Search | `search.py` | BM25 with domain synonym expansion. No AI in this file |
| Answer | `answer.py` | Quantitative synthesis with citations, or refusal |
| Serve | `api.py` | The API and the interface, as one deployable unit |

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

## Asking questions

The answering engine reports the spread of real measurements and cites the
sentence behind each one. When retrieval is thin it says what it searched and
what it could not find, and stops. It will not answer from outside the stored
papers, and it declines questions about advice, prices, companies and
predictions, which measurements cannot answer however well the words match.

`scorecard.py` runs 30 fixed questions, 15 that must be answered and 15 that
must be refused, and fails the build on drift in either direction.

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
