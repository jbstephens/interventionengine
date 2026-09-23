import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryRepository } from "./memory-repository.js";
import type {
  Evaluation,
  InterventionDefinition,
  InterventionRun,
  Measurement,
} from "./types.js";

interface FileShape {
  definitions: InterventionDefinition[];
  runs: InterventionRun[];
  measurements: Measurement[];
  evaluations: Evaluation[];
}

/**
 * Trivial durable repository: the full store as one JSON file, rewritten
 * (atomically, via temp file + rename) after every write. Fine for local use
 * and small datasets; swap in a real database behind Repository when needed.
 */
export class JsonFileRepository extends MemoryRepository {
  constructor(private readonly filePath: string) {
    super();
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return; // no file yet — start empty
    }
    const data = JSON.parse(raw) as FileShape;
    for (const def of data.definitions ?? []) {
      const versions = this.definitions.get(def.id) ?? [];
      versions.push(def);
      versions.sort((a, b) => a.version - b.version);
      this.definitions.set(def.id, versions);
    }
    for (const run of data.runs ?? []) this.runs.set(run.id, run);
    for (const m of data.measurements ?? []) {
      const list = this.measurements.get(m.runId) ?? [];
      list.push(m);
      this.measurements.set(m.runId, list);
    }
    this.evaluations = data.evaluations ?? [];
  }

  private flush(): void {
    const data: FileShape = {
      definitions: [...this.definitions.values()].flat(),
      runs: [...this.runs.values()],
      measurements: [...this.measurements.values()].flat(),
      evaluations: this.evaluations,
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  override async saveDefinition(definition: InterventionDefinition): Promise<void> {
    await super.saveDefinition(definition);
    this.flush();
  }

  override async saveRun(run: InterventionRun): Promise<void> {
    await super.saveRun(run);
    this.flush();
  }

  override async saveMeasurement(measurement: Measurement): Promise<void> {
    await super.saveMeasurement(measurement);
    this.flush();
  }

  override async saveEvaluation(evaluation: Evaluation): Promise<void> {
    await super.saveEvaluation(evaluation);
    this.flush();
  }
}
