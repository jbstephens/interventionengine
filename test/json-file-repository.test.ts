import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InterventionEngine, JsonFileRepository } from "../src/index.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("JsonFileRepository", () => {
  it("persists the full lifecycle across engine restarts", async () => {
    dir = mkdtempSync(join(tmpdir(), "intervention-engine-"));
    const file = join(dir, "store.json");

    const engine = new InterventionEngine({
      repository: new JsonFileRepository(file),
    });
    await engine.defineIntervention({
      id: "change-subject",
      name: "Change subject line",
      targetTypes: ["email"],
      successMetrics: ["open_rate"],
    });
    const run = await engine.recordRun({
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
      context: { campaignType: "webinar" },
      baseline: { open_rate: 0.2 },
    });
    await engine.recordMeasurement({ runId: run.id, metric: "open_rate", value: 0.26 });
    await engine.evaluateRun(run.id);

    // Fresh engine, same file: everything must be there.
    const reloaded = new InterventionEngine({
      repository: new JsonFileRepository(file),
    });
    const fetchedRun = await reloaded.getRun(run.id);
    expect(fetchedRun.context.campaignType).toBe("webinar");
    expect(await reloaded.getMeasurements(run.id)).toHaveLength(2);
    const perf = await reloaded.getInterventionPerformance("change-subject");
    expect(perf.evaluatedRuns).toBe(1);
    expect(perf.positiveRate).toBe(1);
  });
});
