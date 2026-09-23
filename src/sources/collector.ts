import type { InterventionEngine } from "../engine.js";
import type { Measurement, MeasurementPhase, MetricId } from "../types.js";
import { shiftDays, type MeasurementSource } from "./types.js";

const DEFAULT_WINDOW_DAYS = 7;

export interface CollectionReport {
  /** Measurements written this sweep. */
  collected: Measurement[];
  /** Run ids measured this sweep. */
  runsMeasured: string[];
  /** Applied runs whose measurement window has not yet elapsed. */
  notDue: string[];
  /** Runs already fully measured for their success metrics. */
  alreadyMeasured: string[];
  /** metric ids no configured source could resolve, per run. */
  unresolved: { runId: string; metrics: MetricId[] }[];
}

/**
 * Bridges measurement sources into the engine. This is the plug-and-play
 * piece: define an intervention whose successMetrics are bound to a source
 * (GA4 event, pageviews, GSC clicks, ...), record runs, then run the
 * collector on a schedule — baselines and outcomes flow in as ordinary
 * Measurement records without touching the engine core.
 *
 * The collector is a function you invoke (cron job, CI step, script), not a
 * daemon; the engine stays a passive evidence store.
 */
export class MeasurementCollector {
  constructor(
    private readonly engine: InterventionEngine,
    private readonly sources: MeasurementSource[]
  ) {}

  /**
   * Fetch and record one phase of measurements for a run: the baseline
   * window ends at the run's creation, the outcome window follows it, both
   * sized by the definition's measurementWindowDays (default 7).
   * Returns the measurements written; metrics no source resolves are skipped.
   */
  async collectForRun(
    runId: string,
    phase: MeasurementPhase,
    options: { asOf?: string } = {}
  ): Promise<Measurement[]> {
    const run = await this.engine.getRun(runId);
    const definition = await this.engine.getIntervention(
      run.interventionId,
      run.interventionVersion
    );
    const windowDays = definition.measurementWindowDays ?? DEFAULT_WINDOW_DAYS;
    const window =
      phase === "baseline"
        ? { start: shiftDays(run.createdAt, -windowDays), end: run.createdAt }
        : { start: run.createdAt, end: shiftDays(run.createdAt, windowDays) };

    const collected: Measurement[] = [];
    for (const metric of definition.successMetrics) {
      const source = this.sources.find((s) => s.canResolve(metric));
      if (!source) continue;
      const value = await source.fetch({ metric, target: run.target, window });
      if (value === null) continue;
      collected.push(
        await this.engine.recordMeasurement({
          runId,
          metric,
          value,
          phase,
          source: source.name,
          measuredAt: options.asOf ?? new Date().toISOString(),
        })
      );
    }
    return collected;
  }

  /**
   * Sweep all applied runs: for each whose measurement window has elapsed
   * and whose success metrics lack outcome measurements, fetch outcomes from
   * the configured sources and record them. Idempotent per sweep — runs
   * already covered are reported, not re-fetched. Call this on a schedule.
   */
  async collectDueOutcomes(
    options: { asOf?: string } = {}
  ): Promise<CollectionReport> {
    const asOf = options.asOf ?? new Date().toISOString();
    const report: CollectionReport = {
      collected: [],
      runsMeasured: [],
      notDue: [],
      alreadyMeasured: [],
      unresolved: [],
    };

    for (const run of await this.engine.listRuns({ status: "applied" })) {
      const definition = await this.engine.getIntervention(
        run.interventionId,
        run.interventionVersion
      );
      const windowDays = definition.measurementWindowDays ?? DEFAULT_WINDOW_DAYS;
      if (asOf < shiftDays(run.createdAt, windowDays)) {
        report.notDue.push(run.id);
        continue;
      }

      const existing = await this.engine.getMeasurements(run.id);
      const missing = definition.successMetrics.filter(
        (metric) =>
          !existing.some((m) => m.metric === metric && m.phase === "outcome")
      );
      if (missing.length === 0) {
        report.alreadyMeasured.push(run.id);
        continue;
      }

      const unresolved = missing.filter(
        (metric) => !this.sources.some((s) => s.canResolve(metric))
      );
      if (unresolved.length > 0) {
        report.unresolved.push({ runId: run.id, metrics: unresolved });
      }

      let wrote = false;
      for (const metric of missing) {
        const source = this.sources.find((s) => s.canResolve(metric));
        if (!source) continue;
        const value = await source.fetch({
          metric,
          target: run.target,
          window: {
            start: run.createdAt,
            end: shiftDays(run.createdAt, windowDays),
          },
        });
        if (value === null) continue;
        report.collected.push(
          await this.engine.recordMeasurement({
            runId: run.id,
            metric,
            value,
            phase: "outcome",
            source: source.name,
            measuredAt: asOf,
          })
        );
        wrote = true;
      }
      if (wrote) report.runsMeasured.push(run.id);
    }
    return report;
  }
}
