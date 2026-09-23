import type {
  Evaluation,
  InterventionDefinition,
  InterventionRun,
  Measurement,
  RunStatus,
} from "./types.js";

export interface RunFilter {
  interventionId?: string;
  interventionVersion?: number;
  targetId?: string;
  targetType?: string;
  status?: RunStatus;
}

/**
 * Storage abstraction. Domain objects never depend on a particular database;
 * any backend that can store and retrieve these four record types works.
 *
 * Semantics repositories must uphold:
 * - Definitions are immutable once saved; (id, version) is unique.
 * - saveRun upserts by run id (used for status transitions only).
 * - Measurements and evaluations are append-only.
 * - Returned objects must be safe to mutate without corrupting the store.
 */
export interface Repository {
  saveDefinition(definition: InterventionDefinition): Promise<void>;
  /** Latest version when `version` is omitted. */
  getDefinition(
    id: string,
    version?: number
  ): Promise<InterventionDefinition | undefined>;
  /** All versions of all definitions, or all versions of one id. */
  listDefinitions(id?: string): Promise<InterventionDefinition[]>;

  saveRun(run: InterventionRun): Promise<void>;
  getRun(runId: string): Promise<InterventionRun | undefined>;
  listRuns(filter?: RunFilter): Promise<InterventionRun[]>;

  saveMeasurement(measurement: Measurement): Promise<void>;
  listMeasurements(runId: string): Promise<Measurement[]>;

  saveEvaluation(evaluation: Evaluation): Promise<void>;
  listEvaluations(runId?: string): Promise<Evaluation[]>;
}
