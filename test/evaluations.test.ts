import { describe, expect, it } from "vitest";
import { InterventionEngine } from "../src/index.js";

async function setup(options: { expectedDirection?: "increase" | "decrease" } = {}) {
  const engine = new InterventionEngine();
  await engine.defineIntervention({
    id: "change-subject",
    name: "Change subject line",
    targetTypes: ["email"],
    successMetrics: ["open_rate"],
    expectedDirection: options.expectedDirection,
  });
  return engine;
}

describe("measurements and evaluations", () => {
  it("computes absolute and relative deltas from latest baseline and outcome", async () => {
    const engine = await setup();
    const run = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
      baseline: { open_rate: 0.2 },
    });
    await engine.recordMeasurement({ runId: run.id, metric: "open_rate", value: 0.26 });

    const evaluation = await engine.evaluateRun(run.id);
    expect(evaluation.outcome).toBe("positive");
    expect(evaluation.metrics).toHaveLength(1);
    const metric = evaluation.metrics[0];
    expect(metric.absoluteDelta).toBeCloseTo(0.06);
    expect(metric.relativeDelta).toBeCloseTo(0.3);
  });

  it("uses the latest measurement per phase when there are several", async () => {
    const engine = await setup();
    const run = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
      baseline: { open_rate: 0.2 },
    });
    await engine.recordMeasurement({
      runId: run.id,
      metric: "open_rate",
      value: 0.22,
      measuredAt: "2026-09-23T00:00:00Z",
    });
    await engine.recordMeasurement({
      runId: run.id,
      metric: "open_rate",
      value: 0.25,
      measuredAt: "2026-09-29T00:00:00Z",
    });
    const evaluation = await engine.evaluateRun(run.id);
    expect(evaluation.metrics[0].observed).toBe(0.25);
  });

  it("is direction-aware: a drop is positive when a decrease is expected", async () => {
    const engine = await setup({ expectedDirection: "decrease" });
    const run = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
      baseline: { open_rate: 0.1 },
    });
    await engine.recordMeasurement({ runId: run.id, metric: "open_rate", value: 0.05 });
    const evaluation = await engine.evaluateRun(run.id);
    expect(evaluation.outcome).toBe("positive");
    expect(evaluation.metrics[0].absoluteDelta).toBeCloseTo(-0.05);
  });

  it("returns null relative delta on a zero baseline", async () => {
    const engine = await setup();
    const run = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
      baseline: { open_rate: 0 },
    });
    await engine.recordMeasurement({ runId: run.id, metric: "open_rate", value: 0.1 });
    const evaluation = await engine.evaluateRun(run.id);
    expect(evaluation.metrics[0].relativeDelta).toBeNull();
    expect(evaluation.outcome).toBe("positive");
  });

  it("fails cleanly when baseline or outcome is missing", async () => {
    const engine = await setup();
    const run = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
      baseline: { open_rate: 0.2 },
    });
    await expect(engine.evaluateRun(run.id)).rejects.toThrow(/no evaluable metrics/);
  });

  it("refuses to evaluate runs that were never applied", async () => {
    const engine = await setup();
    const run = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
      status: "recommended",
      baseline: { open_rate: 0.2 },
    });
    await engine.recordMeasurement({ runId: run.id, metric: "open_rate", value: 0.3 });
    await expect(engine.evaluateRun(run.id)).rejects.toThrow(/only applied runs/);
  });

  it("evaluates against the pinned definition version, not the latest", async () => {
    const engine = await setup();
    const run = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
      baseline: { open_rate: 0.2 },
    });
    await engine.recordMeasurement({ runId: run.id, metric: "open_rate", value: 0.26 });
    // v2 swaps the success metric entirely; the v1 run must still evaluate on open_rate.
    await engine.defineIntervention({
      id: "change-subject",
      name: "Change subject line",
      targetTypes: ["email"],
      successMetrics: ["click_rate"],
    });
    const evaluation = await engine.evaluateRun(run.id);
    expect(evaluation.metrics[0].metric).toBe("open_rate");
    expect(evaluation.outcome).toBe("positive");
  });

  it("re-evaluation is deterministic and append-only", async () => {
    const engine = await setup();
    const run = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
      baseline: { open_rate: 0.2 },
    });
    await engine.recordMeasurement({ runId: run.id, metric: "open_rate", value: 0.26 });
    const first = await engine.evaluateRun(run.id);
    const second = await engine.evaluateRun(run.id);
    expect(second.metrics).toEqual(first.metrics);
    expect(await engine.getEvaluations(run.id)).toHaveLength(2);
  });

  it("rejects measurements against unknown runs", async () => {
    const engine = await setup();
    await expect(
      engine.recordMeasurement({ runId: "run_missing", metric: "open_rate", value: 1 })
    ).rejects.toThrow(/Unknown run/);
  });
});
