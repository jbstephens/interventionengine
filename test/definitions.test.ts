import { describe, expect, it } from "vitest";
import { InterventionEngine } from "../src/index.js";

const baseDefinition = {
  id: "change-subject",
  name: "Change subject line",
  targetTypes: ["email"],
  successMetrics: ["open_rate"],
};

describe("intervention definitions", () => {
  it("creates version 1 on first definition", async () => {
    const engine = new InterventionEngine();
    const def = await engine.defineIntervention(baseDefinition);
    expect(def.version).toBe(1);
    expect(def.expectedDirection).toBe("increase");
  });

  it("re-defining the same id creates the next version and preserves prior versions", async () => {
    const engine = new InterventionEngine();
    await engine.defineIntervention(baseDefinition);
    const v2 = await engine.defineIntervention({
      ...baseDefinition,
      description: "refined",
    });
    expect(v2.version).toBe(2);

    const v1 = await engine.getIntervention("change-subject", 1);
    expect(v1.description).toBeUndefined();
    const latest = await engine.getIntervention("change-subject");
    expect(latest.version).toBe(2);
    expect(latest.description).toBe("refined");
  });

  it("stored definitions are immune to caller mutation", async () => {
    const engine = new InterventionEngine();
    const def = await engine.defineIntervention(baseDefinition);
    def.name = "hacked";
    def.successMetrics.push("evil_metric");
    const fetched = await engine.getIntervention("change-subject");
    expect(fetched.name).toBe("Change subject line");
    expect(fetched.successMetrics).toEqual(["open_rate"]);
  });

  it("rejects definitions missing target types or metrics", async () => {
    const engine = new InterventionEngine();
    await expect(
      engine.defineIntervention({ ...baseDefinition, targetTypes: [] })
    ).rejects.toThrow(/target type/);
    await expect(
      engine.defineIntervention({ ...baseDefinition, successMetrics: [] })
    ).rejects.toThrow(/success metric/);
  });

  it("listInterventions returns only the latest version, filtered by target type", async () => {
    const engine = new InterventionEngine();
    await engine.defineIntervention(baseDefinition);
    await engine.defineIntervention({ ...baseDefinition, name: "v2 name" });
    await engine.defineIntervention({
      id: "seo-title-rewrite",
      name: "Rewrite title tag",
      targetTypes: ["page"],
      successMetrics: ["organic_clicks"],
    });

    const emailInterventions = await engine.listInterventions({ targetType: "email" });
    expect(emailInterventions).toHaveLength(1);
    expect(emailInterventions[0].version).toBe(2);
    expect(emailInterventions[0].name).toBe("v2 name");

    const all = await engine.listInterventions();
    expect(all.map((d) => d.id).sort()).toEqual([
      "change-subject",
      "seo-title-rewrite",
    ]);
  });

  it("throws on unknown intervention lookups", async () => {
    const engine = new InterventionEngine();
    await expect(engine.getIntervention("nope")).rejects.toThrow(/Unknown intervention/);
  });
});
