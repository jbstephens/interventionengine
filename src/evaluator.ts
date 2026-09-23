import type {
  EvaluationOutcome,
  InterventionDefinition,
  InterventionRun,
  Measurement,
  MetricEvaluation,
} from "./types.js";

export interface EvaluationResult {
  metrics: MetricEvaluation[];
  outcome: EvaluationOutcome;
}

/**
 * Pluggable scoring logic. Different domains can interpret measurements
 * differently (normalized baselines, traffic-adjusted windows, ...) without
 * changing the engine or the data model.
 */
export interface Evaluator {
  readonly name: string;
  evaluate(
    run: InterventionRun,
    definition: InterventionDefinition,
    measurements: Measurement[]
  ): EvaluationResult;
}

/**
 * v1 evaluator: for each success metric, compare the latest baseline-phase
 * observation to the latest outcome-phase observation and compute raw deltas.
 * The per-metric outcome is direction-aware (a drop is "positive" when the
 * definition expects a decrease). Metrics missing either phase are skipped;
 * if no metric is evaluable, evaluation fails with a clear error.
 */
export class DeltaEvaluator implements Evaluator {
  readonly name = "delta";

  evaluate(
    run: InterventionRun,
    definition: InterventionDefinition,
    measurements: Measurement[]
  ): EvaluationResult {
    const metrics: MetricEvaluation[] = [];

    for (const metric of definition.successMetrics) {
      const baseline = latestValue(measurements, metric, "baseline");
      const observed = latestValue(measurements, metric, "outcome");
      if (baseline === undefined || observed === undefined) continue;

      const absoluteDelta = observed - baseline;
      const relativeDelta = baseline !== 0 ? absoluteDelta / baseline : null;
      const signedDelta =
        definition.expectedDirection === "decrease"
          ? -absoluteDelta
          : absoluteDelta;

      metrics.push({
        metric,
        baseline,
        observed,
        absoluteDelta,
        relativeDelta,
        outcome:
          signedDelta > 0 ? "positive" : signedDelta < 0 ? "negative" : "neutral",
      });
    }

    if (metrics.length === 0) {
      throw new Error(
        `Run ${run.id} has no evaluable metrics: each of [${definition.successMetrics.join(
          ", "
        )}] needs at least one baseline and one outcome measurement`
      );
    }

    return { metrics, outcome: overallOutcome(metrics) };
  }
}

function latestValue(
  measurements: Measurement[],
  metric: string,
  phase: "baseline" | "outcome"
): number | undefined {
  const matching = measurements
    .filter((m) => m.metric === metric && m.phase === phase)
    .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  return matching.length > 0 ? matching[matching.length - 1].value : undefined;
}

function overallOutcome(metrics: MetricEvaluation[]): EvaluationOutcome {
  const hasPositive = metrics.some((m) => m.outcome === "positive");
  const hasNegative = metrics.some((m) => m.outcome === "negative");
  if (hasPositive && hasNegative) return "mixed";
  if (hasPositive) return "positive";
  if (hasNegative) return "negative";
  return "neutral";
}
