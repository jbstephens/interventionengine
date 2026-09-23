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

## Measurement sources (connectors)

Connectors live at the perimeter, never in the core. Two pieces:

- A **`MeasurementSource`** answers one question: *"what was this metric's value, for this target, over this window?"* Each connector below implements that interface for one platform.
- The **`MeasurementCollector`** bridges sources into the engine. It captures pre-intervention baselines when you record a run, and on each sweep it finds every applied run whose measurement window has elapsed, asks the first source that can resolve each missing success metric, and writes the answers in as ordinary `Measurement` records.

The engine core has no idea sources exist — you could also feed measurements in by hand, from a spreadsheet, or from your own pipeline, and everything downstream (evaluation, evidence) behaves identically.

```ts
const collector = new MeasurementCollector(engine, [ga4, gsc, snowflake /* ... */]);

// When a run is recorded: capture its pre-intervention baseline from the same
// source that will later measure the outcome (window: the N days BEFORE the run).
await collector.collectForRun(run.id, "baseline");

// On a schedule — cron, CI, launchd. The collector is a function, not a daemon.
const report = await collector.collectDueOutcomes();
report.runsMeasured;    // runs that got outcome measurements this sweep
report.notDue;          // applied runs whose window hasn't elapsed yet
report.alreadyMeasured; // runs fully covered by earlier sweeps (idempotent)
report.unresolved;      // metrics no configured source can resolve — fix your bindings
```

Windows come from the intervention definition's `measurementWindowDays` (default 7): baseline is the window *ending at* the run's creation, outcome is the window *following* it. When multiple sources can resolve the same metric id, the first in the array wins.

All connectors are zero-dependency: raw REST plus `node:crypto` for auth (Google service-account JWTs, Snowflake key-pair JWTs, OAuth client-credentials). Every connector accepts a `fetchImpl` override (for testing/proxies) and a `TokenProvider` (`{ getAccessToken(): Promise<string> }`) anywhere it accepts credentials, so you can plug in your own token management.

| Connector | Target (`target.id`) | Metrics | Auth |
|---|---|---|---|
| `Ga4Source` | anything mappable to a GA4 dimension | any GA4 metric or event, bound per metric id | Google service account |
| `GscSource` | page URL | organic clicks / impressions / ctr / position | Google service account |
| `BigQuerySource` | anything your SQL references | any Standard SQL aggregate | Google service account |
| `SnowflakeSource` | anything your SQL references | any SQL aggregate | key-pair JWT (or OAuth/PAT) |
| `SalesforceSource` | account / opportunity / anything | any SOQL aggregate | connected-app client credentials |
| `MarketoSource` | email asset id | delivered / opens / clicks / open_rate / click_rate | client credentials |
| `OutreachSource` | sequence id | delivered / open / click / reply / bounce rates | bearer token |
| `StaticSource` | anything | constants or functions — tests, demos, manual data | — |

### Google Analytics 4 — `Ga4Source`

Bind your metric ids to GA4 metrics or events, scoped to the run's target. **Setup:** create a Google Cloud service account, download its key JSON, and add its email as a **Viewer** on the GA4 property (Admin → Property Access Management). The property id is the numeric id under Admin → Property Settings.

```ts
const ga4 = new Ga4Source({
  propertyId: "421337009",
  auth: JSON.parse(readFileSync("service-account.json", "utf8")),
  metrics: {
    // A GA4 metric, scoped to the target (here: a page's path):
    page_views: {
      ga4Metric: "screenPageViews",
      targetFilter: (target) => ({ dimension: "pagePath", value: target.id }),
    },
    // An event count — your "success = a GA4 event" case:
    signups: {
      ga4Metric: "eventCount",
      eventName: "sign_up",
      targetFilter: (target) => ({ dimension: "landingPage", value: target.id }),
    },
    // Property-wide value: omit targetFilter.
    sessions: { ga4Metric: "sessions" },
  },
});
```

Any [GA4 API metric](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema) works (`sessions`, `conversions`, `engagementRate`, ...). `targetFilter` supports `matchType`: `EXACT` (default), `BEGINS_WITH`, `CONTAINS`, `FULL_REGEXP`, etc. A window with no matching rows reports 0 — "nothing happened" is a real observation.

### Google Search Console — `GscSource`

Organic search performance for page targets. **Setup:** same service-account key as GA4; add the service account's email as a user on the Search Console property.

```ts
const gsc = new GscSource({
  siteUrl: "sc-domain:example.com",           // exactly as registered in GSC
  auth: JSON.parse(readFileSync("service-account.json", "utf8")),
  pageUrl: (target) => `https://example.com${target.id}`, // default: target.id as-is
  // metrics: { organic_clicks: "clicks", ... }  // this mapping is the default
});
```

Default metric ids: `organic_clicks`, `organic_impressions`, `organic_ctr`, `organic_position`; remap via `metrics`. A page with no search traffic reports 0 clicks/impressions but `null` (unknown) ctr/position. GSC data lags ~2–3 days — give SEO interventions generous `measurementWindowDays` (28+) so sweeps run after data lands.

### BigQuery — `BigQuerySource`

Arbitrary Standard SQL — any metric that lives in your warehouse. Each binding builds a query from the target and window; the query returns one row whose **first column** is the value. **Setup:** service account with **BigQuery Job User** on the project and **Data Viewer** on the queried datasets.

```ts
const bigquery = new BigQuerySource({
  projectId: "acme-analytics",
  auth: JSON.parse(readFileSync("service-account.json", "utf8")),
  location: "US",                              // optional dataset location
  metrics: {
    trial_starts: (t, w) => `
      SELECT COUNT(*) FROM \`acme.product.events\`
      WHERE account_id = '${t.id}' AND name = 'trial_start'
        AND ts BETWEEN '${w.start}' AND '${w.end}'`,
    weekly_active_users: (t, w) => `
      SELECT COUNT(DISTINCT user_id) FROM \`acme.product.events\`
      WHERE org_id = '${t.id}' AND ts BETWEEN '${w.start}' AND '${w.end}'`,
  },
});
```

Long-running queries are polled to completion. `NULL` aggregates and empty result sets report 0. Note the bindings interpolate `target.id` into SQL — target ids come from your own system, but if they can contain quotes, sanitize in the binding.

### Snowflake — `SnowflakeSource`

Same arbitrary-SQL model as BigQuery, over Snowflake's SQL API. **Setup:** generate an RSA key pair, register the public key on a Snowflake user (`ALTER USER svc SET RSA_PUBLIC_KEY='MIIB...'`), and pass the private key — the connector mints Snowflake's key-pair JWTs itself (`SnowflakeKeyPairAuth`, also exported standalone). Alternatively pass any `TokenProvider` (OAuth/PAT) with a matching `tokenType`.

```ts
const snowflake = new SnowflakeSource({
  account: "myorg-account1",                   // as in your account URL
  auth: { user: "SVC_INTERVENTION", privateKey: readFileSync("rsa_key.p8", "utf8") },
  warehouse: "ANALYTICS_WH",
  database: "MARKETING",
  schema: "PUBLIC",                            // warehouse/database/schema/role all optional
  metrics: {
    qualified_leads: (t, w) => `
      SELECT COUNT(*) FROM leads
      WHERE campaign_id = '${t.id}' AND status = 'MQL'
        AND created_at BETWEEN '${w.start}' AND '${w.end}'`,
  },
});
```

Statements still executing (HTTP 202) are polled via their statement handle. Same first-column/one-row convention and NULL→0 behavior as BigQuery.

### Salesforce — `SalesforceSource`

Outcome data from your CRM: pipeline created, closed-won value, stage progressions, activities per account. Because every org's schema differs (stage names, record types, custom fields), bindings are explicit SOQL rather than a canned metric list — same shape as the warehouse connectors. **Setup:** a Connected App with the client-credentials flow enabled and a run-as user; or pass any `TokenProvider`.

```ts
const salesforce = new SalesforceSource({
  instanceUrl: "https://yourorg.my.salesforce.com",
  auth: { clientId: "...", clientSecret: "..." },
  metrics: {
    pipeline_created: (t, w) => `
      SELECT SUM(Amount) value FROM Opportunity
      WHERE AccountId = '${t.id}'
        AND CreatedDate >= ${w.start} AND CreatedDate <= ${w.end}`,
    closed_won_value: (t, w) => `
      SELECT SUM(Amount) value FROM Opportunity
      WHERE AccountId = '${t.id}' AND IsWon = true
        AND CloseDate >= ${w.start.slice(0, 10)} AND CloseDate <= ${w.end.slice(0, 10)}`,
  },
});
```

The query must return a single aggregate row; `SUM()` over zero rows reports 0.

### Marketo — `MarketoSource`

Email engagement for email targets, where `target.id` is the Marketo **email asset id**. Counts delivered/open/click activities for that asset over the window via the activities API — deduplicated by lead, the way Marketo's own email reports count — and derives rates. **Setup:** an API-only user + custom service (LaunchPoint) for client credentials; the REST base URL is on Admin → Web Services.

```ts
const marketo = new MarketoSource({
  baseUrl: "https://123-ABC-456.mktorest.com",
  auth: { clientId: "...", clientSecret: "..." },
  // metrics: { email_delivered, email_opens, email_clicks, open_rate, click_rate } — the default; remap as needed
});
```

Rates are distinct-lead counts over distinct delivered leads; `open_rate`/`click_rate` report `null` (not 0) when nothing was delivered in the window. Activity paging is followed automatically; be mindful of API-call quotas on very large sends.

### Outreach — `OutreachSource`

Sequence performance for sequence targets, where `target.id` is the Outreach **sequence id**. Pages the sequence's mailings delivered in the window and derives delivery/open/click/reply/bounce stats. **Setup:** an OAuth app; pass a bearer token or `TokenProvider`. Outreach rotates refresh tokens on every use, so refresh management deliberately stays with the host — hand the connector fresh tokens via your `TokenProvider`.

```ts
const outreach = new OutreachSource({
  auth: { accessToken: process.env.OUTREACH_TOKEN! },
  // metrics: { outreach_delivered, outreach_open_rate, outreach_click_rate,
  //            outreach_reply_rate, outreach_bounce_rate } — the default; remap as needed
});
```

Rates are per delivered mailing (bounces excluded from the denominator, except `bounce_rate`); all rates report `null` when nothing was delivered.

### Manual / testing — `StaticSource`

Constants or functions of the target and window — for tests, demos, spreadsheet-sourced data, or any metric you'd rather supply yourself.

```ts
const manual = new StaticSource(
  { nps_score: 42, revenue: (target, window) => lookupRevenue(target.id, window) },
  { name: "finance-sheet" }
);
```

### Writing your own connector

Implement two methods and add it to the collector's array:

```ts
class PostHogSource implements MeasurementSource {
  readonly name = "posthog";
  canResolve(metric: MetricId): boolean { /* is this metric mine? */ }
  async fetch({ metric, target, window }: MetricRequest): Promise<number | null> {
    // Query your platform; return the value, or null for "no answer"
    // (null = skipped and collectable later; 0 = a real observation of nothing).
  }
}
```

That's the entire contract. PostHog, Plausible, Mixpanel, HubSpot, Stripe — each is an afternoon.

**A note on verification:** the Google and warehouse connectors are tested against recorded request/response shapes, and all auth flows are tested down to JWT signing — but none of these have been run against live credentials yet. Smoke-test the connectors you adopt before trusting a production sweep.

`npm run demo:collector` shows the full plug-and-play flow (with a stand-in source, so it runs credential-free).

## Boundaries

| Layer | Owns | Status |
|---|---|---|
| **Intervention Engine** (this) | definitions, runs, measurements, evaluations, aggregate evidence | ✅ built |
| **Recommendation layer** | selection, ranking, reasoning, LLM prompting | mock in demo |
| **Execution layer** | generating the actual subject lines / title tags / actions | future |
| **Host applications** (an SEO tool, a marketing platform, a sales system, ...) | targets, source analytics, domain taxonomies, adapters feeding measurements in | yours |

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
    ga4-source.ts, gsc-source.ts, bigquery-source.ts, snowflake-source.ts,
    salesforce-source.ts, marketo-source.ts, outreach-source.ts, static-source.ts
examples/marketing-demo.ts # DEFINE→APPLY→MEASURE→EVALUATE→LEARN→RECOMMEND
examples/collector-demo.ts # plug-and-play measurement collection
test/                      # 46 invariant + adapter tests
```

## Explicitly deferred

Candidate-intervention discovery workflow, evidence-strength taxonomy, experiment/control representation, exploration-vs-exploitation, further source connectors (PostHog, Plausible, HubSpot, Mixpanel, Stripe), SQL/Firestore repositories, and any statistical intelligence beyond honest counting. The data model was shaped so none of these require a rewrite.
