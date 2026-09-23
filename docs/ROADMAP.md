# Roadmap

Things worth considering as the project matures — roughly ordered by how much they'd improve trust in the system. None of these change the core data model; the versioning, snapshot, and lifecycle invariants are settled and well-tested. Everything below lives at the edges, which is where evolution should happen.

## 1. Live verification of connectors

The Google and warehouse connectors are tested against recorded request/response shapes, and every auth flow is tested down to JWT signing — but none of the connectors have been exercised against live credentials. Areas most likely to hold surprises:

- Marketo: exact behavior of the `assetIds` filter on the activities endpoint, and paging behavior on large sends.
- Outreach: precise JSON:API filter syntax for the sequence relationship and `deliveredAt` date ranges.
- Salesforce: the client-credentials flow requires explicit enablement on the Connected App; org configuration varies.

A good shape for this: a small smoke-test harness (one command per connector, real credentials, one known-good query) that records actual responses as fixtures, so the unit tests exercise true payload shapes rather than reconstructions. Until then, smoke-test any connector before trusting a production sweep.

## 2. Fault isolation in the collector

`collectDueOutcomes()` currently lets an error in any single source fetch — a rate limit, an expired token, one bad binding — abort the entire sweep, including runs that would have succeeded. Before running the collector on a schedule in earnest, it should:

- isolate failures per run (and per metric), so one failure never blocks the rest of the sweep;
- report failures in the `CollectionReport` alongside `unresolved`;
- retry transient errors with backoff, and respect per-source rate limits.

This is the most concrete near-term improvement in the codebase.

## 3. Statistical guardrails on evidence

The evidence API is honest about what it computes but silent about how weak the evidence can be. Two traps deserve attention:

- **Small samples.** Positive rates are reported as bare numbers; a 100% positive rate over 1 run reads the same as 100% over 40. Consider Wilson (or similar) confidence intervals on positive rates and a minimum-evidence annotation on `InterventionPerformance` responses, so consumers can distinguish "strong signal" from "two data points."
- **Regression to the mean.** Interventions tend to be selected *because* a metric is below benchmark, and below-benchmark metrics drift back up on their own — so naive pre/post deltas will systematically flatter interventions. A benchmark-adjusted evaluator (delta versus a peer baseline over the same window, not just versus self) would counteract this. The pluggable `Evaluator` interface exists precisely so such evaluators can be added without touching the engine.

Related: the model already leaves room for an evidence-strength dimension (pre/post → matched comparison → A/B → randomized), where stronger designs are better-labeled evaluations over the same primitives.

## 4. A concurrent-safe storage backend

`JsonFileRepository` rewrites the full store on every write and has no locking — two processes (say, a scheduled collector sweep and an interactive session) can clobber each other. It is intended for local, single-process use. SQLite is the natural next `Repository` implementation: durable, concurrent-safe, still a single file, and the interface was designed for it. Postgres/Firestore follow the same path when multi-user hosting matters.

## 5. Evaluation windows as more than advice

`measurementWindowDays` is currently advisory: evaluation compares the latest baseline to the latest outcome measurement regardless of when they were taken, so a measurement recorded months late still counts as the outcome. Consider a window-enforcing evaluator (only measurements inside the window qualify) and/or a data-sufficiency check ("enough observations to evaluate?") — both fit behind the existing `Evaluator` interface. Source-specific data lag (e.g. Search Console's ~2–3 days) also argues for scheduling sweeps with margin rather than exactly at window end.

## 6. Richer context matching

"Comparable situations" currently means exact key/value equality in `getInterventionPerformance({ context })`, and `groupBy` can fragment on high-cardinality keys. The recommendation story leans on context similarity, so it may eventually deserve: numeric range matching, partial/weighted matches, or explicit context schemas per domain. Worth designing carefully — this is the boundary between honest counting and modeling.

## 7. Backfill and seeding

Evidence currently accumulates only going forward. Most adopters have years of historical actions and outcomes in their systems already. A bulk import path — record runs with historical `createdAt`, attach historical measurements, evaluate in batch — would let a deployment start with a seeded evidence base instead of an empty one. The API already accepts explicit timestamps everywhere; what's missing is a convenient bulk workflow and guidance on mapping historical actions onto a taxonomy honestly (retroactively labeling actions as interventions has its own selection-bias risks).

## 8. The recommendation layer

The recommender in `examples/marketing-demo.ts` is deliberately a mock. A real one would add: an LLM-backed selector whose structured output is validated against the known intervention taxonomy (it must return an existing intervention id, never an invented action), evidence-aware ranking with explicit exploration of under-tested interventions, and the candidate-intervention workflow (model or human notices a recurring recommendation that fits no defined intervention → candidate → human review → new versioned definition). These belong in a layer or package that consumes the engine, keeping the engine itself a passive evidence store.

## 9. Smaller items

- **Parameterized queries** for the SQL connectors (BigQuery and Snowflake both support query parameters) instead of string interpolation of target ids.
- **More connectors**: PostHog, Plausible, Mixpanel, HubSpot, Stripe. Each is two methods; see "Writing your own connector" in the README.
- **Pagination** on `listRuns`/`listEvaluations` for large histories.
- **Intervention lifecycle**: a deprecation status for definitions that should no longer be recommended but must remain resolvable for history.
- **npm publishing** and a changelog, once the API has had some real-world miles.
