# Deferred

Ideas raised during the build that are deliberately not implemented. Each says
why it was left out, so the decision can be revisited rather than rediscovered.

## Corpus

- **arXiv and ChemRxiv preprints.** The `papers` table already carries
  `is_preprint` and `source`, and `collect_papers.py` writes both, so adding a
  second collector means a new source function and a re-run of the chain.
  Left out of this pass because preprints are unreviewed and the evaluator is
  judging reliability first.
- **Review articles.** `type:article` excludes them. Reviews tabulate
  comparisons that would be rich extraction targets, but their numbers are
  second-hand, and a row whose quote is itself a citation of another paper
  weakens the provenance claim. Worth adding behind a `source_is_review` flag.
- **Non-English papers.** The extractor's vocabulary is English only.

## Extraction

- **Areal and volumetric capacity.** Only gravimetric capacity is normalised.
  `mAh/cm2` and `mAh/cm3` appear often and currently go unread.
- **Electrolyte composition beyond the salt.** Solvent ratios and additives are
  not parsed.
- **Sentence pairs.** A row is scoped to one sentence, so a result split across
  two consecutive sentences ("The anode delivered 1200 mAh/g. After 500 cycles
  it retained 88%.") produces two partial rows instead of one complete one.
  Joining them needs coreference and would weaken the guarantee that every
  number in a row was reported together.
- **Table parsing.** `fetch_text.py` keeps table captions but not table bodies.
  Most comparable numbers in a paper live in its tables.

## Checks

- **Per-chemistry plausibility bounds.** One global ceiling of 5000 mAh/g is
  wrong for lithium-air, where capacities are quoted per gram of carbon. The
  flag reason explains this, but a per-chemistry bound would be better than an
  explanation.
- **Flag severity.** `multiple_capacities_in_sentence` is an ambiguity note and
  `capacity_above_5000_mah_g` is a probable error; both currently render the
  same. They should separate.
- **A domain expert.** No battery chemist has reviewed any of this. Every check
  here is mechanical. This is the largest open risk in the project and no
  amount of further automation closes it.

## Product

- **Vector search.** Retrieval is BM25 over FTS5. `pgvector` and a sentence
  transformer were specified; they were dropped because the embedding model
  needs a download this environment blocks, and lexical search performs well on
  the technical vocabulary of this corpus. The `chunks` table is already shaped
  for an `embedding` column.
- **Saved views that persist.** The view selector is preset-only; it does not
  store a user's own filter combinations.
- **Column pinning and reordering** in the evidence grid.
- **Charts.** A capacity distribution per material system, and a capacity
  against cycle-count scatter, would both earn their place. Deliberately left
  out of this pass so the first screen stays a table of numbers rather than a
  dashboard.
- **Postgres.** The schema in `db.py` mirrors the brief's Postgres design and
  is a port of one file. SQLite was chosen so the product deploys as a single
  unit; a shared multi-writer deployment would need the move.
