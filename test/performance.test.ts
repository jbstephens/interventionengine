import { describe, expect, it } from "vitest";
import { InterventionEngine } from "../src/index.js";

async function seededEngine() {
  const engine = new InterventionEngine();
  await engine.defineIntervention({
    id: "change-subject",
    name: "Change subject line",
    targetTypes: ["email"],
    successMetrics: ["open_rate"],
  });

  const applyAndMeasure = async (
    targetId: string,
    context: Record<string, unknown>,
    baseline: number,
    observed: number
  ) => {
    const run = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: targetId, type: "email" },
      context,
      baseline: { open_rate: baseline },
    });
    await engine.recordMeasurement({ runId: run.id, metric: "open_rate", value: observed });
    await engine.evaluateRun(run.id);
    return run;
  };

  await applyAndMeasure("email-1", { campaignType: "webinar" }, 0.2, 0.26); // +30%
  await applyAndMeasure("email-2", { campaignType: "webinar" }, 0.2, 0.22); // +10%
  await applyAndMeasure("email-3", { campaignType: "newsletter" }, 0.3, 0.27); // -10%
  return engine;
}

describe("intervention performance", () => {
  it("aggregates evaluated runs: counts, outcomes, deltas, median", async () => {
    const engine = await seededEngine();
    const perf = await engine.getInterventionPerformance("change-subject");

    expect(perf.runs).toBe(3);
    expect(perf.evaluatedRuns).toBe(3);
    expect(perf.outcomes).toMatchObject({ positive: 2, negative: 1 });
    expect(perf.positiveRate).toBeCloseTo(2 / 3);

    const metric = perf.metrics.open_rate;
    expect(metric.count).toBe(3);
    expect(metric.meanAbsoluteDelta).toBeCloseTo((0.06 + 0.02 - 0.03) / 3);
    expect(metric.medianRelativeDelta).toBeCloseTo(0.1);
  });

  it("excludes unapplied and unevaluated runs from outcome stats", async () => {
    const engine = await seededEngine();
    // An ignored recommendation and an applied-but-not-yet-measured run.
    await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-4", type: "email" },
      status: "recommended",
    });
    await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-5", type: "email" },
      baseline: { open_rate: 0.2 },
    });

    const perf = await engine.getInterventionPerformance("change-subject");
    expect(perf.runs).toBe(5);
    expect(perf.byStatus.recommended).toBe(1);
    expect(perf.byStatus.applied).toBe(4);
    expect(perf.evaluatedRuns).toBe(3);
    expect(perf.positiveRate).toBeCloseTo(2 / 3);
  });

  it("filters evidence by context", async () => {
    const engine = await seededEngine();
    const webinar = await engine.getInterventionPerformance("change-subject", {
      context: { campaignType: "webinar" },
    });
    expect(webinar.evaluatedRuns).toBe(2);
    expect(webinar.positiveRate).toBe(1);

    const newsletter = await engine.getInterventionPerformance("change-subject", {
      context: { campaignType: "newsletter" },
    });
    expect(newsletter.evaluatedRuns).toBe(1);
    expect(newsletter.positiveRate).toBe(0);
  });

  it("breaks evidence down by context key", async () => {
    const engine = await seededEngine();
    const perf = await engine.getInterventionPerformance("change-subject", {
      groupBy: ["campaignType"],
    });
    expect(perf.byContext!.campaignType.webinar).toMatchObject({
      evaluatedRuns: 2,
      positiveRate: 1,
    });
    expect(perf.byContext!.campaignType.newsletter).toMatchObject({
      evaluatedRuns: 1,
      positiveRate: 0,
    });
  });

  it("uses only the latest evaluation per run", async () => {
    const engine = await seededEngine();
    const [run] = await engine.listRuns({ targetId: "email-1" });
    await engine.evaluateRun(run.id); // second evaluation of the same run
    const perf = await engine.getInterventionPerformance("change-subject");
    expect(perf.evaluatedRuns).toBe(3); // not double-counted
  });

  it("throws for unknown interventions", async () => {
    const engine = await seededEngine();
    await expect(engine.getInterventionPerformance("nope")).rejects.toThrow(
      /Unknown intervention/
    );
  });
});
