import type {
  ContextSlicePerformance,
  Evaluation,
  InterventionPerformance,
  InterventionRun,
  MetricPerformance,
  OutcomeCounts,
  PerformanceOptions,
  RunStatus,
} from "./types.js";

const RUN_STATUSES: RunStatus[] = [
  "recommended",
  "accepted",
  "rejected",
  "applied",
  "expired",
];

/**
 * Pure aggregation over runs and their latest evaluations. Only applied runs
 * with an evaluation contribute to outcome stats; recommendations that were
 * never executed count toward byStatus but never toward performance.
 */
export function computePerformance(
  interventionId: string,
  runs: InterventionRun[],
  evaluations: Evaluation[],
  options: PerformanceOptions = {}
): InterventionPerformance {
  const filtered = options.context
    ? runs.filter((run) => contextMatches(run.context, options.context!))
    : runs;

  const byStatus = Object.fromEntries(
    RUN_STATUSES.map((s) => [s, 0])
  ) as Record<RunStatus, number>;
  for (const run of filtered) byStatus[run.status] += 1;

  const latestEvaluationByRun = new Map<string, Evaluation>();
  for (const evaluation of evaluations) {
    const current = latestEvaluationByRun.get(evaluation.runId);
    if (!current || evaluation.evaluatedAt >= current.evaluatedAt) {
      latestEvaluationByRun.set(evaluation.runId, evaluation);
    }
  }

  const evaluated = filtered
    .filter((run) => run.status === "applied")
    .map((run) => ({ run, evaluation: latestEvaluationByRun.get(run.id) }))
    .filter(
      (pair): pair is { run: InterventionRun; evaluation: Evaluation } =>
        pair.evaluation !== undefined
    );

  const outcomes = countOutcomes(evaluated.map((e) => e.evaluation));

  const metrics: Record<string, MetricPerformance> = {};
  const perMetric = new Map<
    string,
    { absolute: number[]; relative: number[]; positive: number; count: number }
  >();
  for (const { evaluation } of evaluated) {
    for (const m of evaluation.metrics) {
      const stats =
        perMetric.get(m.metric) ??
        { absolute: [], relative: [], positive: 0, count: 0 };
      stats.count += 1;
      stats.absolute.push(m.absoluteDelta);
      if (m.relativeDelta !== null) stats.relative.push(m.relativeDelta);
      if (m.outcome === "positive") stats.positive += 1;
      perMetric.set(m.metric, stats);
    }
  }
  for (const [metric, stats] of perMetric) {
    metrics[metric] = {
      count: stats.count,
      meanAbsoluteDelta: mean(stats.absolute)!,
      meanRelativeDelta: mean(stats.relative),
      medianRelativeDelta: median(stats.relative),
      positiveRate: stats.positive / stats.count,
    };
  }

  const performance: InterventionPerformance = {
    interventionId,
    runs: filtered.length,
    byStatus,
    evaluatedRuns: evaluated.length,
    outcomes,
    positiveRate:
      evaluated.length > 0 ? outcomes.positive / evaluated.length : null,
    metrics,
  };

  if (options.groupBy && options.groupBy.length > 0) {
    performance.byContext = {};
    for (const key of options.groupBy) {
      const slices: Record<string, ContextSlicePerformance> = {};
      const groups = new Map<string, Evaluation[]>();
      for (const { run, evaluation } of evaluated) {
        const value =
          run.context[key] === undefined ? "(none)" : String(run.context[key]);
        const list = groups.get(value) ?? [];
        list.push(evaluation);
        groups.set(value, list);
      }
      for (const [value, groupEvaluations] of groups) {
        const groupOutcomes = countOutcomes(groupEvaluations);
        slices[value] = {
          evaluatedRuns: groupEvaluations.length,
          outcomes: groupOutcomes,
          positiveRate:
            groupEvaluations.length > 0
              ? groupOutcomes.positive / groupEvaluations.length
              : null,
        };
      }
      performance.byContext[key] = slices;
    }
  }

  return performance;
}

function contextMatches(
  context: Record<string, unknown>,
  filter: Record<string, unknown>
): boolean {
  return Object.entries(filter).every(([key, value]) => context[key] === value);
}

function countOutcomes(evaluations: Evaluation[]): OutcomeCounts {
  const counts: OutcomeCounts = { positive: 0, negative: 0, neutral: 0, mixed: 0 };
  for (const evaluation of evaluations) counts[evaluation.outcome] += 1;
  return counts;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}
