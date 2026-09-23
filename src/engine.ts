import { randomUUID } from "node:crypto";
import { DeltaEvaluator, type Evaluator } from "./evaluator.js";
import { MemoryRepository } from "./memory-repository.js";
import { computePerformance } from "./performance.js";
import type { Repository, RunFilter } from "./repository.js";
import type {
  Evaluation,
  InterventionDefinition,
  InterventionDefinitionInput,
  InterventionPerformance,
  InterventionRun,
  Measurement,
  MeasurementPhase,
  MetricId,
  PerformanceOptions,
  RunStatus,
  TargetRef,
} from "./types.js";

export interface EngineOptions {
  repository?: Repository;
  evaluator?: Evaluator;
}

export interface RecordRunInput {
  interventionId: string;
  /** Pins a specific definition version; defaults to the latest at record time. */
  interventionVersion?: number;
  target: TargetRef;
  context?: Record<string, unknown>;
  /** Convenience: written as baseline-phase measurements timestamped at the run's creation. */
  baseline?: Record<MetricId, number>;
  reasonSelected?: string;
  confidence?: number;
  /** Defaults to "applied" (the common "I did this, now track it" case). */
  status?: RunStatus;
  /** Override for backfilling history; defaults to now. */
  createdAt?: string;
}

export interface RecordMeasurementInput {
  runId: string;
  metric: MetricId;
  value: number;
  /** Defaults to "outcome". */
  phase?: MeasurementPhase;
  measuredAt?: string;
  source?: string;
}

/**
 * Intervention Engine: a durable evidence system for interventions.
 *
 * It owns definitions, runs, measurements, evaluations, and aggregate
 * evidence. It deliberately does NOT select interventions, generate
 * executions, or claim causality — recommenders and host applications
 * sit on top and consume its primitives.
 */
export class InterventionEngine {
  private readonly repository: Repository;
  private readonly evaluator: Evaluator;

  constructor(options: EngineOptions = {}) {
    this.repository = options.repository ?? new MemoryRepository();
    this.evaluator = options.evaluator ?? new DeltaEvaluator();
  }

  // ── Definitions ────────────────────────────────────────────────────────

  /**
   * Define an intervention, or version an existing one: reusing an id
   * creates the next version and preserves all prior versions untouched.
   */
  async defineIntervention(
    input: InterventionDefinitionInput
  ): Promise<InterventionDefinition> {
    if (!input.id) throw new Error("Intervention id is required");
    if (!input.targetTypes?.length) {
      throw new Error(`Intervention "${input.id}" needs at least one target type`);
    }
    if (!input.successMetrics?.length) {
      throw new Error(`Intervention "${input.id}" needs at least one success metric`);
    }
    const latest = await this.repository.getDefinition(input.id);
    const definition: InterventionDefinition = {
      ...input,
      expectedDirection: input.expectedDirection ?? "increase",
      version: latest ? latest.version + 1 : 1,
      createdAt: new Date().toISOString(),
    };
    await this.repository.saveDefinition(definition);
    return definition;
  }

  async getIntervention(
    id: string,
    version?: number
  ): Promise<InterventionDefinition> {
    const definition = await this.repository.getDefinition(id, version);
    if (!definition) {
      throw new Error(
        `Unknown intervention "${id}"${version !== undefined ? `@${version}` : ""}`
      );
    }
    return definition;
  }

  /** Latest version of each intervention, optionally filtered by eligible target type. */
  async listInterventions(options: {
    targetType?: string;
  } = {}): Promise<InterventionDefinition[]> {
    const all = await this.repository.listDefinitions();
    const latestById = new Map<string, InterventionDefinition>();
    for (const definition of all) {
      const current = latestById.get(definition.id);
      if (!current || definition.version > current.version) {
        latestById.set(definition.id, definition);
      }
    }
    let result = [...latestById.values()];
    if (options.targetType !== undefined) {
      result = result.filter((d) => d.targetTypes.includes(options.targetType!));
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }

  // ── Runs ───────────────────────────────────────────────────────────────

  /**
   * Record one recommendation/application of an intervention against a
   * target. Pins the definition version and snapshots context immutably.
   */
  async recordRun(input: RecordRunInput): Promise<InterventionRun> {
    const definition = await this.getIntervention(
      input.interventionId,
      input.interventionVersion
    );
    if (!definition.targetTypes.includes(input.target.type)) {
      throw new Error(
        `Intervention "${definition.id}" is not applicable to target type ` +
          `"${input.target.type}" (eligible: ${definition.targetTypes.join(", ")})`
      );
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const status = input.status ?? "applied";
    const run: InterventionRun = {
      id: `run_${randomUUID()}`,
      interventionId: definition.id,
      interventionVersion: definition.version,
      target: { ...input.target },
      context: structuredClone(input.context ?? {}),
      reasonSelected: input.reasonSelected,
      confidence: input.confidence,
      status,
      statusHistory: [{ status, at: createdAt }],
      createdAt,
    };
    await this.repository.saveRun(run);

    if (input.baseline) {
      for (const [metric, value] of Object.entries(input.baseline)) {
        await this.recordMeasurement({
          runId: run.id,
          metric,
          value,
          phase: "baseline",
          measuredAt: createdAt,
        });
      }
    }
    return run;
  }

  async getRun(runId: string): Promise<InterventionRun> {
    const run = await this.repository.getRun(runId);
    if (!run) throw new Error(`Unknown run "${runId}"`);
    return run;
  }

  async listRuns(filter: RunFilter = {}): Promise<InterventionRun[]> {
    return this.repository.listRuns(filter);
  }

  /** Advance a run's lifecycle (e.g. recommended → applied). History is preserved. */
  async updateRunStatus(
    runId: string,
    status: RunStatus,
    at?: string
  ): Promise<InterventionRun> {
    const run = await this.getRun(runId);
    run.status = status;
    run.statusHistory.push({ status, at: at ?? new Date().toISOString() });
    await this.repository.saveRun(run);
    return run;
  }

  // ── Measurements ───────────────────────────────────────────────────────

  async recordMeasurement(input: RecordMeasurementInput): Promise<Measurement> {
    await this.getRun(input.runId); // fail loudly on unknown runs
    const measurement: Measurement = {
      id: `mea_${randomUUID()}`,
      runId: input.runId,
      metric: input.metric,
      value: input.value,
      phase: input.phase ?? "outcome",
      measuredAt: input.measuredAt ?? new Date().toISOString(),
      source: input.source,
    };
    await this.repository.saveMeasurement(measurement);
    return measurement;
  }

  async getMeasurements(runId: string): Promise<Measurement[]> {
    return this.repository.listMeasurements(runId);
  }

  // ── Evaluations ────────────────────────────────────────────────────────

  /**
   * Interpret a run's measurements. Only applied runs can be evaluated —
   * an ignored recommendation is not evidence of an intervention failing.
   * Append-only: re-evaluating creates a new record and aggregation uses
   * the latest per run.
   */
  async evaluateRun(
    runId: string,
    options: { evaluator?: Evaluator } = {}
  ): Promise<Evaluation> {
    const run = await this.getRun(runId);
    if (run.status !== "applied") {
      throw new Error(
        `Run "${runId}" has status "${run.status}"; only applied runs can be evaluated`
      );
    }
    const definition = await this.getIntervention(
      run.interventionId,
      run.interventionVersion
    );
    const measurements = await this.repository.listMeasurements(runId);
    const evaluator = options.evaluator ?? this.evaluator;
    const result = evaluator.evaluate(run, definition, measurements);
    const evaluation: Evaluation = {
      id: `eva_${randomUUID()}`,
      runId,
      evaluator: evaluator.name,
      metrics: result.metrics,
      outcome: result.outcome,
      evaluatedAt: new Date().toISOString(),
    };
    await this.repository.saveEvaluation(evaluation);
    return evaluation;
  }

  async getEvaluations(runId: string): Promise<Evaluation[]> {
    return this.repository.listEvaluations(runId);
  }

  // ── Evidence ───────────────────────────────────────────────────────────

  /**
   * Aggregated observational evidence for an intervention, optionally
   * filtered by context and/or broken down by context keys. This is the
   * read surface a recommendation layer consumes.
   */
  async getInterventionPerformance(
    interventionId: string,
    options: PerformanceOptions = {}
  ): Promise<InterventionPerformance> {
    await this.getIntervention(interventionId); // fail loudly on unknown ids
    const runs = await this.repository.listRuns({ interventionId });
    const evaluations = await this.repository.listEvaluations();
    return computePerformance(interventionId, runs, evaluations, options);
  }
}
