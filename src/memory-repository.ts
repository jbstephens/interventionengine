import type { Repository, RunFilter } from "./repository.js";
import type {
  Evaluation,
  InterventionDefinition,
  InterventionRun,
  Measurement,
} from "./types.js";

const clone = <T>(value: T): T => structuredClone(value);

/**
 * In-memory repository. Deep-clones on both write and read so stored records
 * are immune to later mutation by callers — context snapshots stay snapshots.
 */
export class MemoryRepository implements Repository {
  protected definitions = new Map<string, InterventionDefinition[]>();
  protected runs = new Map<string, InterventionRun>();
  protected measurements = new Map<string, Measurement[]>();
  protected evaluations: Evaluation[] = [];

  async saveDefinition(definition: InterventionDefinition): Promise<void> {
    const versions = this.definitions.get(definition.id) ?? [];
    if (versions.some((d) => d.version === definition.version)) {
      throw new Error(
        `Definition ${definition.id}@${definition.version} already exists and is immutable`
      );
    }
    versions.push(clone(definition));
    versions.sort((a, b) => a.version - b.version);
    this.definitions.set(definition.id, versions);
  }

  async getDefinition(
    id: string,
    version?: number
  ): Promise<InterventionDefinition | undefined> {
    const versions = this.definitions.get(id);
    if (!versions || versions.length === 0) return undefined;
    const found =
      version === undefined
        ? versions[versions.length - 1]
        : versions.find((d) => d.version === version);
    return found ? clone(found) : undefined;
  }

  async listDefinitions(id?: string): Promise<InterventionDefinition[]> {
    const all =
      id === undefined
        ? [...this.definitions.values()].flat()
        : this.definitions.get(id) ?? [];
    return clone(all);
  }

  async saveRun(run: InterventionRun): Promise<void> {
    this.runs.set(run.id, clone(run));
  }

  async getRun(runId: string): Promise<InterventionRun | undefined> {
    const run = this.runs.get(runId);
    return run ? clone(run) : undefined;
  }

  async listRuns(filter: RunFilter = {}): Promise<InterventionRun[]> {
    const result = [...this.runs.values()].filter(
      (run) =>
        (filter.interventionId === undefined ||
          run.interventionId === filter.interventionId) &&
        (filter.interventionVersion === undefined ||
          run.interventionVersion === filter.interventionVersion) &&
        (filter.targetId === undefined || run.target.id === filter.targetId) &&
        (filter.targetType === undefined ||
          run.target.type === filter.targetType) &&
        (filter.status === undefined || run.status === filter.status)
    );
    result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return clone(result);
  }

  async saveMeasurement(measurement: Measurement): Promise<void> {
    const list = this.measurements.get(measurement.runId) ?? [];
    list.push(clone(measurement));
    this.measurements.set(measurement.runId, list);
  }

  async listMeasurements(runId: string): Promise<Measurement[]> {
    const list = this.measurements.get(runId) ?? [];
    return clone(list).sort((a, b) => a.measuredAt.localeCompare(b.measuredAt));
  }

  async saveEvaluation(evaluation: Evaluation): Promise<void> {
    this.evaluations.push(clone(evaluation));
  }

  async listEvaluations(runId?: string): Promise<Evaluation[]> {
    const list =
      runId === undefined
        ? this.evaluations
        : this.evaluations.filter((e) => e.runId === runId);
    return clone(list).sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt));
  }
}
