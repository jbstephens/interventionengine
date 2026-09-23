/**
 * Core domain types for Intervention Engine.
 *
 * Everything here is plain, serializable data. No class instances, no
 * domain-specific fields in core objects. Domain semantics (campaign types,
 * page types, funnel stages, ...) live in the untyped `context` bag.
 */

/** Stable string identifier for a metric, e.g. "open_rate", "organic_clicks". */
export type MetricId = string;

export type ExpectedDirection = "increase" | "decrease";

/** Input for defining (or re-defining, i.e. versioning) an intervention. */
export interface InterventionDefinitionInput {
  /** Stable, human-meaningful id, e.g. "email-subject-strategy". */
  id: string;
  name: string;
  description?: string;
  /** Which target types this intervention may be applied to, e.g. ["email"]. */
  targetTypes: string[];
  /** Metrics used to judge this intervention's outcome. */
  successMetrics: MetricId[];
  /** Which direction of movement counts as success. Defaults to "increase". */
  expectedDirection?: ExpectedDirection;
  /** Advisory default window between applying and evaluating. */
  measurementWindowDays?: number;
  /** Free-form extra data (category, tags, domain, ...). */
  metadata?: Record<string, unknown>;
}

/**
 * An immutable, versioned definition of one stable category of action.
 * Re-defining the same id creates a new version; prior versions are preserved
 * so historical runs are never silently reinterpreted.
 */
export interface InterventionDefinition extends InterventionDefinitionInput {
  version: number;
  expectedDirection: ExpectedDirection;
  createdAt: string;
}

/** Reference to a target owned by the host application. The engine never owns targets. */
export interface TargetRef {
  id: string;
  type: string;
}

/**
 * Lifecycle of a run. A run may begin life as a recommendation and only
 * later (or never) be applied. Only applied runs are eligible for evaluation,
 * so ignored recommendations can never masquerade as failed interventions.
 */
export type RunStatus =
  | "recommended"
  | "accepted"
  | "rejected"
  | "applied"
  | "expired";

export interface RunStatusChange {
  status: RunStatus;
  at: string;
}

/**
 * One instance of an intervention being recommended and/or applied to a
 * target. Pins the exact definition version and snapshots context at
 * decision time. This is the bridge between taxonomy and evidence.
 */
export interface InterventionRun {
  id: string;
  interventionId: string;
  interventionVersion: number;
  target: TargetRef;
  /** Immutable snapshot of what was known when the intervention was selected. */
  context: Record<string, unknown>;
  /** Why the selector (human, rules, or LLM) chose this intervention. Explanatory, not analytic. */
  reasonSelected?: string;
  /** The selector's confidence in this recommendation (NOT evidence confidence, which is derived from history). */
  confidence?: number;
  status: RunStatus;
  statusHistory: RunStatusChange[];
  createdAt: string;
}

export type MeasurementPhase = "baseline" | "outcome";

/**
 * One observed metric value for a run, at a point in time, from a source.
 * Baselines and outcomes are both measurements, distinguished by `phase`;
 * multiple observations per metric per phase are allowed.
 */
export interface Measurement {
  id: string;
  runId: string;
  metric: MetricId;
  value: number;
  phase: MeasurementPhase;
  measuredAt: string;
  source?: string;
}

export type MetricOutcome = "positive" | "negative" | "neutral";
export type EvaluationOutcome = MetricOutcome | "mixed";

/** Per-metric interpretation of observed vs baseline. Deltas are raw; `outcome` is direction-aware. */
export interface MetricEvaluation {
  metric: MetricId;
  baseline: number;
  observed: number;
  absoluteDelta: number;
  /** (observed - baseline) / baseline; null when baseline is zero. */
  relativeDelta: number | null;
  outcome: MetricOutcome;
}

/**
 * An interpretation of a run's measurements. Append-only: re-evaluating
 * creates a new record; aggregation uses the latest per run.
 *
 * An evaluation states what was observed after the intervention. It is
 * observational evidence, not a causal claim.
 */
export interface Evaluation {
  id: string;
  runId: string;
  evaluator: string;
  metrics: MetricEvaluation[];
  outcome: EvaluationOutcome;
  evaluatedAt: string;
}

/** Aggregate stats for one metric across evaluated runs. */
export interface MetricPerformance {
  count: number;
  meanAbsoluteDelta: number;
  meanRelativeDelta: number | null;
  medianRelativeDelta: number | null;
  positiveRate: number;
}

export interface OutcomeCounts {
  positive: number;
  negative: number;
  neutral: number;
  mixed: number;
}

/** Aggregate stats for a slice of runs sharing a context value. */
export interface ContextSlicePerformance {
  evaluatedRuns: number;
  outcomes: OutcomeCounts;
  positiveRate: number | null;
}

/**
 * Aggregated historical evidence for one intervention, optionally filtered
 * and/or broken down by context. These are observational summaries — the
 * engine makes no causal claims.
 */
export interface InterventionPerformance {
  interventionId: string;
  /** All runs matching the filter, regardless of status. */
  runs: number;
  byStatus: Record<RunStatus, number>;
  /** Applied runs with at least one evaluation. Only these feed outcome stats. */
  evaluatedRuns: number;
  outcomes: OutcomeCounts;
  /** positive / evaluatedRuns; null when nothing has been evaluated. */
  positiveRate: number | null;
  metrics: Record<MetricId, MetricPerformance>;
  /** Present when groupBy context keys were requested: key -> value -> slice stats. */
  byContext?: Record<string, Record<string, ContextSlicePerformance>>;
}

export interface PerformanceOptions {
  /** Only include runs whose context matches all of these key/value pairs. */
  context?: Record<string, unknown>;
  /** Context keys to break performance down by (e.g. ["campaignType"]). */
  groupBy?: string[];
}
