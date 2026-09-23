# Intervention Engine

**Intervention Engine turns AI recommendations from ephemeral advice into measurable, reusable interventions whose historical outcomes can improve future decisions.**

Constrain the action space, instrument every intervention, observe outcomes, and accumulate evidence about what works where.

```
DEFINE → APPLY → MEASURE → EVALUATE → LEARN → (recommend next)
```

## What it is / isn't

Intervention Engine is a small, domain-agnostic **evidence system**. It owns four record types and the aggregation over them:

| Object | Answers |
|---|---|
| **Intervention Definition** | What actions is the system allowed to take? (bounded, versioned taxonomy) |
| **Intervention Run** | When was an intervention recommended/applied, to what, under what conditions, and why? |
| **Measurement** | What metric values were observed, when, from where? |
| **Evaluation** | How should the observations be interpreted relative to baseline? |

It is deliberately **not** a recommender, an experimentation platform, a causal-inference system, an agent framework, or a marketing product. Those sit on top of it and consume its primitives. It has **zero runtime dependencies** and stores plain serializable data behind a swappable `Repository` interface.

Think of it as **analytics telemetry for decisions**: normal analytics records "user clicked button"; Intervention Engine records "system chose intervention X for target Y under context Z for reason R — and here's what was observed afterward."

## Quickstart

```bash
npm install
npm test        # 28 invariant tests
npm run demo    # full lifecycle on a toy marketing domain
```

```ts
import { InterventionEngine, JsonFileRepository } from "intervention-engine";

const engine = new InterventionEngine({
  repository: new JsonFileRepository("./data/interventions.json"), // or omit for in-memory
});

// DEFINE — a stable, versioned category of action
await engine.defineIntervention({
  id: "change-subject-strategy",
  name: "Change subject-line strategy",
  targetTypes: ["email"],
  successMetrics: ["open_rate"],
  expectedDirection: "increase",
  measurementWindowDays: 7,
});

// APPLY — record one use against an external target, snapshotting context
const run = await engine.recordRun({
  interventionId: "change-subject-strategy",
  target: { id: "email-142", type: "email" },
  context: { campaignType: "webinar", audience: "enterprise_prospect" },
  baseline: { open_rate: 0.21 },
  reasonSelected: "Open rate below benchmark; post-open engagement healthy",
  confidence: 0.84,
});

// MEASURE — outcomes flow in from any source (Marketo, GA4, GSC, manual, ...)
await engine.recordMeasurement({
  runId: run.id,
  metric: "open_rate",
  value: 0.27,
  source: "marketo",
});

// EVALUATE — interpret observed vs baseline (pluggable; DeltaEvaluator by default)
await engine.evaluateRun(run.id);

// LEARN — context-conditioned observational evidence
const evidence = await engine.getInterventionPerformance("change-subject-strategy", {
  context: { campaignType: "webinar" },   // filter to comparable situations
  groupBy: ["audience"],                  // or break down by context key
});
```

## Closing the loop: how learnings drive recommendations

The engine does not select interventions — that boundary is deliberate. Instead it exposes exactly the read surface a recommendation layer needs, and accepts the write-back that makes the flywheel spin:

1. **Eligibility** — `listInterventions({ targetType })`: which known actions apply to this kind of target.
2. **Evidence** — `getInterventionPerformance(id, { context, groupBy })`: how each candidate has historically performed, *conditioned on context resembling the current situation*, not just global averages.
3. **Selection** — a recommender (deterministic rules, a ranking model, or an LLM handed the evidence pack) picks from the known intervention ids. An LLM may reason freely, but its structured answer must resolve to an existing `interventionId` — it cannot invent actions.
4. **Write-back** — the decision is recorded via `recordRun({ status: "recommended", reasonSelected, confidence, context, baseline })`.
5. **Flywheel** — when the human applies it (`updateRunStatus(runId, "applied")`), measurements arrive, evaluation runs, and this decision becomes the next unit of evidence improving step 2.

`examples/marketing-demo.ts` demonstrates this end-to-end, including the JSON "evidence pack" you would put in front of an LLM.

This is the credibility mechanism: not "here are five plausible ideas," but *"we recommend X because these signals triggered it and X has a 78% positive rate across 67 comparable evaluated runs."* The accumulated run/outcome history is proprietary evidence a frontier model doesn't have.

## Design decisions

**Recommendation vs execution** — One `InterventionRun` with a lifecycle `status` (`recommended | accepted | rejected | applied | expired`) plus append-only `statusHistory`, rather than separate Recommendation and Run objects. `evaluateRun` refuses non-applied runs and aggregation counts only applied+evaluated runs, so an ignored recommendation can never masquerade as a failed intervention — which was the semantic that mattered. Acceptance behavior stays analyzable via `byStatus`. A separate Recommendation object can be introduced later without breaking this model.

**Baseline storage** — Baselines are `Measurement` records with `phase: "baseline"` (vs `"outcome"`), not fields on the run. One record type covers multiple baseline observations, multi-metric baselines, and temporal series; evaluation compares latest-baseline to latest-outcome per metric. `recordRun`'s `baseline: {...}` convenience keeps ergonomics simple by writing baseline measurements for you.

**Versioning** — Definitions are immutable per `(id, version)`. Re-defining an id auto-increments the version. Runs pin `interventionVersion` at record time, and evaluation loads the *pinned* version — so changing what an intervention means never reinterprets history (tested).

**Context snapshots** — `context` is an untyped `Record<string, unknown>` deep-cloned at record time; repositories clone on read and write, so snapshots are immune to later mutation (tested). No domain fields (`campaignType`, `queryIntent`, ...) exist in core — hosts define their own vocabulary, and that same vocabulary drives context filtering/grouping in performance queries. Retaining context per run is also what makes later selection-bias analysis possible at all.

**Evaluation** — Pluggable `Evaluator` interface (`evaluate(run, definition, measurements)`); v1 ships `DeltaEvaluator`: absolute and relative deltas, direction-aware outcomes (a drop is *positive* when the definition expects a decrease). Evaluations are append-only; re-evaluating adds a record and aggregation uses the latest per run, preserving auditability. `measurementWindowDays` is advisory in v1; a window-enforcing or data-sufficiency evaluator slots in behind the same interface.

**Metrics** — Plain string ids (`open_rate`, `organic_clicks`). No metric ontology until one earns its keep.

**Confidence** — `run.confidence` is the *selector's* confidence at decision time. *Evidence* confidence is never stored — it is derived from history (run counts, positive rates, recency) at query time. The demo's ranker shows why: a 100% positive rate over 1 run must lose to 100% over 3.

**Causality** — Evaluations state what was observed after an intervention, nothing more. The model leaves room for an evidence-strength dimension later (pre/post → matched comparison → A/B → RCT) without restructuring: stronger designs are just better-labeled evaluations over the same run/measurement primitives.

## Measurement sources (integrations)

Integrations live at the perimeter, never in the core: a `MeasurementSource` answers "what was this metric's value for this target over this window?", and the `MeasurementCollector` sweeps applied runs whose measurement window has elapsed, queries the right source, and writes ordinary `Measurement` records. The engine core has no idea sources exist.

```ts
import {
  Ga4Source, GscSource, MarketoSource, OutreachSource, SalesforceSource,
  MeasurementCollector,
} from "intervention-engine";

const ga4 = new Ga4Source({
  propertyId: "421337009",
  auth: JSON.parse(readFileSync("service-account.json", "utf8")), // Viewer on the property
  metrics: {
    // Bind YOUR metric ids to GA4 queries, scoped by the run's target:
    page_views: {
      ga4Metric: "screenPageViews",
      targetFilter: (target) => ({ dimension: "pagePath", value: target.id }),
    },
    signups: { ga4Metric: "eventCount", eventName: "sign_up" },
  },
});

const collector = new MeasurementCollector(engine, [ga4 /*, gsc, marketo, ...*/]);

// At run creation: capture the pre-intervention baseline from the same source.
await collector.collectForRun(run.id, "baseline");

// On a schedule (cron, CI, launchd — the collector is a function, not a daemon):
const report = await collector.collectDueOutcomes();
// -> fetches outcomes for every applied run whose window has elapsed,
//    skips runs already measured, reports metrics no source can resolve.
```

Built-in sources (zero dependencies — raw REST + native crypto for auth):

| Source | Target | Metrics | Auth |
|---|---|---|---|
| `Ga4Source` | anything mappable to a GA4 dimension | any GA4 metric or event, bound per metric id | Google service account |
| `GscSource` | page URL | organic clicks / impressions / ctr / position | Google service account |
| `MarketoSource` | Marketo email asset id | delivered / opens / clicks / open_rate / click_rate (distinct-lead, via activities API) | client credentials |
| `OutreachSource` | sequence id | delivered / open / click / reply / bounce rates (via mailings) | bearer token (host manages refresh — Outreach rotates refresh tokens) |
| `SalesforceSource` | account / opportunity / anything | any SOQL aggregate you bind (pipeline created, closed-won value, stage progressions) — org schemas differ too much for a canned list | connected-app client credentials |
| `StaticSource` | anything | constants or functions — tests, demos, spreadsheet data | — |

Writing a new adapter is implementing two methods (`canResolve`, `fetch`) — PostHog, Plausible, Mixpanel, HubSpot, Stripe, or a Snowflake query are each an afternoon. The Google adapters are tested against recorded request/response shapes; the Marketo/Outreach/Salesforce adapters are written to the documented APIs but should get a smoke test against live credentials before production use.

`npm run demo:collector` shows the full plug-and-play flow (with a stand-in source, so it runs credential-free).

## Boundaries

| Layer | Owns | Status |
|---|---|---|
| **Intervention Engine** (this) | definitions, runs, measurements, evaluations, aggregate evidence | ✅ built |
| **Recommendation layer** | selection, ranking, reasoning, LLM prompting | mock in demo |
| **Execution layer** | generating the actual subject lines / title tags / actions | future |
| **Host applications** (OptimizeTrack, Marketing OS, ...) | targets, source analytics, domain taxonomies, adapters feeding measurements in | future |

## Layout

```
src/
  types.ts                 # all domain types (plain data, serializable)
  repository.ts            # storage interface + semantics contracts
  memory-repository.ts     # in-memory impl (deep-clone isolation)
  json-file-repository.ts  # trivial durable impl (atomic JSON file)
  evaluator.ts             # Evaluator interface + DeltaEvaluator
  performance.ts           # pure aggregation (filter, groupBy, medians)
  engine.ts                # the API surface
  sources/                 # measurement integrations (perimeter, not core)
    collector.ts           # sweeps due runs, records baselines/outcomes
    ga4-source.ts, gsc-source.ts, marketo-source.ts,
    outreach-source.ts, salesforce-source.ts, static-source.ts
examples/marketing-demo.ts # DEFINE→APPLY→MEASURE→EVALUATE→LEARN→RECOMMEND
examples/collector-demo.ts # plug-and-play measurement collection
test/                      # 46 invariant + adapter tests
```

## Explicitly deferred

Candidate-intervention discovery workflow, evidence-strength taxonomy, experiment/control representation, exploration-vs-exploitation, further source adapters (PostHog, Plausible, HubSpot, Mixpanel, Stripe, Snowflake), SQL/Firestore repositories, and any statistical intelligence beyond honest counting. The data model was shaped so none of these require a rewrite.
