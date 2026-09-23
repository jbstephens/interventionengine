/**
 * Toy marketing domain demonstrating the full Intervention Engine lifecycle:
 *
 *   DEFINE -> APPLY -> MEASURE -> EVALUATE -> LEARN -> (recommend next)
 *
 * The last section is a deliberately tiny mock recommender showing how a
 * recommendation layer (rules, ranking model, or LLM) consumes the engine's
 * evidence and writes its decision back in — closing the flywheel. In a real
 * system, the "evidence pack" printed below is exactly what you would put in
 * front of an LLM, with the constraint that its answer must be one of the
 * known intervention ids.
 *
 * Run with: npm run demo
 */
import { InterventionEngine, type InterventionPerformance } from "../src/index.js";

const engine = new InterventionEngine(); // in-memory; pass JsonFileRepository for durability

// ── 1. DEFINE: a bounded taxonomy of three email interventions ───────────

await engine.defineIntervention({
  id: "change-subject-strategy",
  name: "Change subject-line strategy",
  description: "Modify the strategic approach used by the email subject line.",
  targetTypes: ["email"],
  successMetrics: ["open_rate"],
  expectedDirection: "increase",
  measurementWindowDays: 7,
});

await engine.defineIntervention({
  id: "change-cta",
  name: "Change call to action",
  description: "Replace or reposition the email's primary call to action.",
  targetTypes: ["email"],
  successMetrics: ["click_rate"],
  expectedDirection: "increase",
  measurementWindowDays: 7,
});

await engine.defineIntervention({
  id: "simplify-content",
  name: "Simplify email content",
  description: "Reduce length and complexity of the email body.",
  targetTypes: ["email"],
  successMetrics: ["click_rate"],
  expectedDirection: "increase",
  measurementWindowDays: 7,
});

console.log("Defined interventions:");
for (const def of await engine.listInterventions({ targetType: "email" })) {
  console.log(`  ${def.id}@${def.version} — ${def.name}`);
}

// ── 2. APPLY + 3. MEASURE + 4. EVALUATE: simulated historical runs ───────

interface SimulatedRun {
  interventionId: string;
  targetId: string;
  context: Record<string, unknown>;
  metric: string;
  baseline: number;
  observed: number;
}

const history: SimulatedRun[] = [
  // Subject-line changes work well for webinar campaigns...
  { interventionId: "change-subject-strategy", targetId: "email-101", context: { campaignType: "webinar", audience: "enterprise_prospect" }, metric: "open_rate", baseline: 0.21, observed: 0.27 },
  { interventionId: "change-subject-strategy", targetId: "email-102", context: { campaignType: "webinar", audience: "enterprise_prospect" }, metric: "open_rate", baseline: 0.19, observed: 0.24 },
  { interventionId: "change-subject-strategy", targetId: "email-103", context: { campaignType: "webinar", audience: "mid_market" }, metric: "open_rate", baseline: 0.22, observed: 0.28 },
  // ...but poorly for already-healthy customer newsletters.
  { interventionId: "change-subject-strategy", targetId: "email-104", context: { campaignType: "newsletter", audience: "customer" }, metric: "open_rate", baseline: 0.31, observed: 0.29 },
  { interventionId: "change-subject-strategy", targetId: "email-105", context: { campaignType: "newsletter", audience: "customer" }, metric: "open_rate", baseline: 0.28, observed: 0.285 },
  // CTA changes: mixed results.
  { interventionId: "change-cta", targetId: "email-106", context: { campaignType: "webinar", audience: "enterprise_prospect" }, metric: "click_rate", baseline: 0.03, observed: 0.031 },
  { interventionId: "change-cta", targetId: "email-107", context: { campaignType: "nurture", audience: "mid_market" }, metric: "click_rate", baseline: 0.025, observed: 0.024 },
  { interventionId: "change-cta", targetId: "email-108", context: { campaignType: "newsletter", audience: "customer" }, metric: "click_rate", baseline: 0.04, observed: 0.046 },
  // Simplifying content: one clear win, one small loss.
  { interventionId: "simplify-content", targetId: "email-109", context: { campaignType: "nurture", audience: "enterprise_prospect" }, metric: "click_rate", baseline: 0.02, observed: 0.03 },
  { interventionId: "simplify-content", targetId: "email-110", context: { campaignType: "webinar", audience: "customer" }, metric: "click_rate", baseline: 0.032, observed: 0.031 },
];

for (const sim of history) {
  const run = await engine.recordRun({
    interventionId: sim.interventionId,
    target: { id: sim.targetId, type: "email" },
    context: sim.context,
    baseline: { [sim.metric]: sim.baseline },
    reasonSelected: "Simulated historical run",
    status: "applied",
  });
  await engine.recordMeasurement({
    runId: run.id,
    metric: sim.metric,
    value: sim.observed,
    source: "marketo",
  });
  await engine.evaluateRun(run.id);
}

// A recommendation the marketer ignored — recorded, but never evaluated,
// so it cannot pollute outcome statistics.
await engine.recordRun({
  interventionId: "simplify-content",
  target: { id: "email-111", type: "email" },
  context: { campaignType: "newsletter", audience: "customer" },
  status: "recommended",
  reasonSelected: "Body copy is 3x longer than peer newsletters",
});

// ── Versioning: refining a definition never rewrites history ─────────────

await engine.defineIntervention({
  id: "change-subject-strategy",
  name: "Change subject-line strategy",
  description:
    "Modify the strategic approach of the subject line (specificity, curiosity, urgency, length).",
  targetTypes: ["email"],
  successMetrics: ["open_rate"],
  expectedDirection: "increase",
  measurementWindowDays: 7,
});
const oldRuns = await engine.listRuns({ interventionId: "change-subject-strategy" });
console.log(
  `\nDefinition updated to v2; the ${oldRuns.length} historical runs remain pinned to v${oldRuns[0].interventionVersion}.`
);

// ── 5. LEARN: aggregated, context-conditioned evidence ───────────────────

console.log("\n=== Historical evidence ===");
for (const id of ["change-subject-strategy", "change-cta", "simplify-content"]) {
  const perf = await engine.getInterventionPerformance(id, {
    groupBy: ["campaignType"],
  });
  console.log(`\n${id}:`);
  console.log(`  runs: ${perf.runs} (applied+evaluated: ${perf.evaluatedRuns})`);
  console.log(`  positive rate: ${formatRate(perf.positiveRate)}`);
  for (const [metric, stats] of Object.entries(perf.metrics)) {
    console.log(
      `  ${metric}: mean Δ ${stats.meanAbsoluteDelta.toFixed(3)} ` +
        `(median relative ${formatRate(stats.medianRelativeDelta)})`
    );
  }
  for (const [value, slice] of Object.entries(perf.byContext!.campaignType)) {
    console.log(
      `    campaignType=${value}: ${slice.evaluatedRuns} runs, ` +
        `positive rate ${formatRate(slice.positiveRate)}`
    );
  }
}

// ── 6. RECOMMEND: a mock recommendation layer consuming the evidence ─────
//
// This is the boundary in action. The recommender:
//   1. asks the engine which interventions are eligible for the target type,
//   2. pulls evidence, both overall and conditioned on the target's context,
//   3. ranks candidates (an LLM would reason over this same evidence pack,
//      constrained to return a known intervention id),
//   4. writes its decision back into the engine as a "recommended" run —
//      which, once applied and measured, becomes tomorrow's evidence.

const newTarget = { id: "email-200", type: "email" };
const newContext = { campaignType: "webinar", audience: "enterprise_prospect" };

console.log("\n=== Mock recommender ===");
console.log(`New target: ${newTarget.id}, context: ${JSON.stringify(newContext)}`);

interface Candidate {
  interventionId: string;
  name: string;
  overall: InterventionPerformance;
  inContext: InterventionPerformance;
}

const candidates: Candidate[] = [];
for (const def of await engine.listInterventions({ targetType: newTarget.type })) {
  candidates.push({
    interventionId: def.id,
    name: def.name,
    overall: await engine.getInterventionPerformance(def.id),
    inContext: await engine.getInterventionPerformance(def.id, {
      context: { campaignType: newContext.campaignType },
    }),
  });
}

// The evidence pack: what you would hand an LLM alongside the target's
// current signals, with instructions to pick from these ids only.
console.log("\nEvidence pack (what an LLM recommender would receive):");
console.log(
  JSON.stringify(
    candidates.map((c) => ({
      interventionId: c.interventionId,
      name: c.name,
      overall: {
        evaluatedRuns: c.overall.evaluatedRuns,
        positiveRate: c.overall.positiveRate,
      },
      matchingContext: {
        filter: { campaignType: newContext.campaignType },
        evaluatedRuns: c.inContext.evaluatedRuns,
        positiveRate: c.inContext.positiveRate,
      },
    })),
    null,
    2
  )
);

// Trivial ranking: prefer context-conditioned evidence, fall back to overall,
// and break ties toward the candidate with MORE evaluated runs. A positive
// rate of 100% over 3 runs is stronger evidence than 100% over 1 run —
// this is "evidence confidence", derived from history, distinct from the
// selector's recommendation confidence stored on the run.
const ranked = [...candidates].sort(
  (a, b) =>
    score(b) - score(a) ||
    b.inContext.evaluatedRuns - a.inContext.evaluatedRuns
);
const best = ranked[0];

const recommendation = await engine.recordRun({
  interventionId: best.interventionId,
  target: newTarget,
  context: newContext,
  status: "recommended",
  confidence: score(best),
  reasonSelected:
    `Historically strongest for campaignType=${newContext.campaignType}: ` +
    `positive rate ${formatRate(score(best))} across ` +
    `${best.inContext.evaluatedRuns} comparable evaluated runs`,
});

console.log(`\nRecommendation written back as ${recommendation.id}:`);
console.log(`  intervention: ${recommendation.interventionId}@${recommendation.interventionVersion}`);
console.log(`  reason: ${recommendation.reasonSelected}`);
console.log(
  "\nWhen the marketer applies it, updateRunStatus + measurements + evaluateRun" +
    "\nturn this recommendation into the next unit of evidence. That is the flywheel."
);

function score(candidate: Candidate): number {
  if (candidate.inContext.evaluatedRuns > 0 && candidate.inContext.positiveRate !== null) {
    return candidate.inContext.positiveRate;
  }
  return candidate.overall.positiveRate ?? 0;
}

function formatRate(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(0)}%`;
}
