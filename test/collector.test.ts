import { describe, expect, it } from "vitest";
import {
  InterventionEngine,
  MeasurementCollector,
  StaticSource,
} from "../src/index.js";

async function setup() {
  const engine = new InterventionEngine();
  await engine.defineIntervention({
    id: "seo-title-rewrite",
    name: "Rewrite title tag",
    targetTypes: ["page"],
    successMetrics: ["page_views"],
    measurementWindowDays: 7,
  });
  return engine;
}

describe("MeasurementCollector", () => {
  it("captures baseline over the window before the run and outcome after it", async () => {
    const engine = await setup();
    const windows: string[] = [];
    const collector = new MeasurementCollector(engine, [
      new StaticSource(
        {
          page_views: (_target, window) => {
            windows.push(`${window.start}|${window.end}`);
            return 100;
          },
        },
        { name: "fake-ga4" }
      ),
    ]);

    const run = await engine.recordRun({
      interventionId: "seo-title-rewrite",
      target: { id: "/blog/foo", type: "page" },
      createdAt: "2026-09-10T00:00:00.000Z",
    });
    await collector.collectForRun(run.id, "baseline");
    await collector.collectForRun(run.id, "outcome");

    expect(windows).toEqual([
      "2026-09-03T00:00:00.000Z|2026-09-10T00:00:00.000Z",
      "2026-09-10T00:00:00.000Z|2026-09-17T00:00:00.000Z",
    ]);
    const measurements = await engine.getMeasurements(run.id);
    expect(measurements.map((m) => m.phase).sort()).toEqual(["baseline", "outcome"]);
    expect(measurements[0].source).toBe("fake-ga4");
  });

  it("sweeps only due runs, skips measured ones, and reports unresolved metrics", async () => {
    const engine = await setup();
    await engine.defineIntervention({
      id: "add-internal-links",
      name: "Add internal links",
      targetTypes: ["page"],
      successMetrics: ["mystery_metric"], // no source can resolve this
      measurementWindowDays: 7,
    });
    const collector = new MeasurementCollector(engine, [
      new StaticSource({ page_views: 42 }),
    ]);

    const dueRun = await engine.recordRun({
      interventionId: "seo-title-rewrite",
      target: { id: "/blog/due", type: "page" },
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const freshRun = await engine.recordRun({
      interventionId: "seo-title-rewrite",
      target: { id: "/blog/fresh", type: "page" },
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    const unresolvableRun = await engine.recordRun({
      interventionId: "add-internal-links",
      target: { id: "/blog/mystery", type: "page" },
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    // Recommended-only runs must never be swept.
    await engine.recordRun({
      interventionId: "seo-title-rewrite",
      target: { id: "/blog/ignored", type: "page" },
      status: "recommended",
      createdAt: "2026-09-01T00:00:00.000Z",
    });

    const report = await collector.collectDueOutcomes({
      asOf: "2026-09-20T00:00:00.000Z",
    });
    expect(report.runsMeasured).toEqual([dueRun.id]);
    expect(report.notDue).toEqual([freshRun.id]);
    expect(report.unresolved).toEqual([
      { runId: unresolvableRun.id, metrics: ["mystery_metric"] },
    ]);
    expect(report.collected).toHaveLength(1);
    expect(report.collected[0]).toMatchObject({
      metric: "page_views",
      value: 42,
      phase: "outcome",
      measuredAt: "2026-09-20T00:00:00.000Z",
    });

    // Second sweep is idempotent: the due run is now already measured.
    const second = await collector.collectDueOutcomes({
      asOf: "2026-09-20T00:00:00.000Z",
    });
    expect(second.runsMeasured).toEqual([]);
    expect(second.alreadyMeasured).toContain(dueRun.id);
    expect(second.collected).toHaveLength(0);
  });

  it("first source that can resolve a metric wins", async () => {
    const engine = await setup();
    const collector = new MeasurementCollector(engine, [
      new StaticSource({ page_views: 1 }, { name: "primary" }),
      new StaticSource({ page_views: 2 }, { name: "secondary" }),
    ]);
    const run = await engine.recordRun({
      interventionId: "seo-title-rewrite",
      target: { id: "/blog/foo", type: "page" },
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const report = await collector.collectDueOutcomes({
      asOf: "2026-09-20T00:00:00.000Z",
    });
    expect(report.collected[0]).toMatchObject({ value: 1, source: "primary" });
    expect(run.id).toBe(report.runsMeasured[0]);
  });

  it("skips metrics the source answers null for, leaving them collectable later", async () => {
    const engine = await setup();
    const collector = new MeasurementCollector(engine, [
      new StaticSource({ page_views: () => null }),
    ]);
    const run = await engine.recordRun({
      interventionId: "seo-title-rewrite",
      target: { id: "/blog/foo", type: "page" },
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const report = await collector.collectDueOutcomes({
      asOf: "2026-09-20T00:00:00.000Z",
    });
    expect(report.collected).toHaveLength(0);
    expect(report.runsMeasured).toHaveLength(0);
    expect(await engine.getMeasurements(run.id)).toHaveLength(0);
  });
});
