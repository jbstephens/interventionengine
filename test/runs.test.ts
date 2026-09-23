import { describe, expect, it } from "vitest";
import { InterventionEngine } from "../src/index.js";

async function engineWithDefinition() {
  const engine = new InterventionEngine();
  await engine.defineIntervention({
    id: "change-subject",
    name: "Change subject line",
    targetTypes: ["email"],
    successMetrics: ["open_rate"],
  });
  return engine;
}

describe("intervention runs", () => {
  it("pins the definition version active at record time", async () => {
    const engine = await engineWithDefinition();
    const run = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
    });
    expect(run.interventionVersion).toBe(1);

    // Version the definition afterwards — the historical run must not move.
    await engine.defineIntervention({
      id: "change-subject",
      name: "Changed meaning",
      targetTypes: ["email"],
      successMetrics: ["click_rate"],
    });
    const fetched = await engine.getRun(run.id);
    expect(fetched.interventionVersion).toBe(1);

    const laterRun = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-2", type: "email" },
    });
    expect(laterRun.interventionVersion).toBe(2);
  });

  it("snapshots context immutably at record time", async () => {
    const engine = await engineWithDefinition();
    const context: Record<string, unknown> = { campaignType: "webinar" };
    const run = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
      context,
    });
    context.campaignType = "mutated-after-the-fact";
    const fetched = await engine.getRun(run.id);
    expect(fetched.context.campaignType).toBe("webinar");
  });

  it("writes baseline values as baseline-phase measurements", async () => {
    const engine = await engineWithDefinition();
    const run = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
      baseline: { open_rate: 0.21 },
    });
    const measurements = await engine.getMeasurements(run.id);
    expect(measurements).toHaveLength(1);
    expect(measurements[0]).toMatchObject({
      metric: "open_rate",
      value: 0.21,
      phase: "baseline",
      measuredAt: run.createdAt,
    });
  });

  it("rejects runs against ineligible target types or unknown interventions", async () => {
    const engine = await engineWithDefinition();
    await expect(
      engine.recordRun({
        interventionId: "change-subject",
        target: { id: "page-1", type: "page" },
      })
    ).rejects.toThrow(/not applicable/);
    await expect(
      engine.recordRun({
        interventionId: "does-not-exist",
        target: { id: "email-1", type: "email" },
      })
    ).rejects.toThrow(/Unknown intervention/);
  });

  it("tracks lifecycle status with history", async () => {
    const engine = await engineWithDefinition();
    const run = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
      status: "recommended",
    });
    expect(run.status).toBe("recommended");
    const updated = await engine.updateRunStatus(run.id, "applied");
    expect(updated.status).toBe("applied");
    expect(updated.statusHistory.map((s) => s.status)).toEqual([
      "recommended",
      "applied",
    ]);
  });

  it("filters runs by intervention, target, and status", async () => {
    const engine = await engineWithDefinition();
    await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
      status: "applied",
    });
    await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-2", type: "email" },
      status: "recommended",
    });
    expect(await engine.listRuns({ interventionId: "change-subject" })).toHaveLength(2);
    expect(await engine.listRuns({ status: "applied" })).toHaveLength(1);
    expect(await engine.listRuns({ targetId: "email-2" })).toHaveLength(1);
  });
});
