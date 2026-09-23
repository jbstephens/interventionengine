/**
 * Plug-and-play measurement flow: define an intervention whose success
 * metric is bound to an analytics source, record runs, then let the
 * MeasurementCollector pull baselines and outcomes in on a schedule.
 *
 * This demo uses a StaticSource standing in for GA4 so it runs with no
 * credentials; swap in the commented Ga4Source config for the real thing.
 *
 * Run with: npx tsx examples/collector-demo.ts
 */
import {
  InterventionEngine,
  MeasurementCollector,
  StaticSource,
  // Ga4Source,
} from "../src/index.js";

const engine = new InterventionEngine();

// Real config would look like this — target.id (the page path) scopes the query:
//
// const ga4 = new Ga4Source({
//   propertyId: "421337009",
//   auth: JSON.parse(readFileSync("service-account.json", "utf8")),
//   metrics: {
//     page_views: {
//       ga4Metric: "screenPageViews",
//       targetFilter: (target) => ({ dimension: "pagePath", value: target.id }),
//     },
//     signups: { ga4Metric: "eventCount", eventName: "sign_up" },
//   },
// });

// Stand-in: pageviews grow after the intervention date (Sept 3rd).
const ga4 = new StaticSource(
  {
    page_views: (_target, window) =>
      window.start < "2026-09-03" ? 830 : 1120,
  },
  { name: "ga4" }
);

const collector = new MeasurementCollector(engine, [ga4]);

await engine.defineIntervention({
  id: "seo-title-rewrite",
  name: "Rewrite title tag",
  targetTypes: ["page"],
  successMetrics: ["page_views"],
  expectedDirection: "increase",
  measurementWindowDays: 7,
});

// APPLY: the title was rewritten on Sept 3rd.
const run = await engine.recordRun({
  interventionId: "seo-title-rewrite",
  target: { id: "/blog/how-to-choose-a-crm", type: "page" },
  context: { pageType: "blog", queryIntent: "commercial" },
  createdAt: "2026-09-03T00:00:00.000Z",
});

// Baseline is captured from the source too — no manual numbers.
await collector.collectForRun(run.id, "baseline");
console.log("Baseline captured:", (await engine.getMeasurements(run.id))[0]);

// A week later, the scheduled sweep finds the run due and pulls outcomes.
const report = await collector.collectDueOutcomes({
  asOf: "2026-09-12T00:00:00.000Z",
});
console.log(
  `\nSweep: ${report.runsMeasured.length} run(s) measured, ` +
    `${report.notDue.length} not due, ${report.unresolved.length} unresolved`
);

const evaluation = await engine.evaluateRun(run.id);
const metric = evaluation.metrics[0];
console.log(
  `\nEvaluated: page_views ${metric.baseline} -> ${metric.observed} ` +
    `(${((metric.relativeDelta ?? 0) * 100).toFixed(1)}%, ${evaluation.outcome})`
);

const perf = await engine.getInterventionPerformance("seo-title-rewrite");
console.log(
  `\nEvidence: ${perf.evaluatedRuns} evaluated run(s), ` +
    `positive rate ${(perf.positiveRate! * 100).toFixed(0)}%`
);
