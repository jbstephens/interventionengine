import type { MetricId, TargetRef } from "../types.js";
import type {
  MeasurementSource,
  MeasurementWindow,
  MetricRequest,
} from "./types.js";

export type StaticMetricValue =
  | number
  | ((target: TargetRef, window: MeasurementWindow) => number | null);

/**
 * A measurement source backed by a plain object — for tests, demos, and
 * manual/spreadsheet data. Values may be constants or functions of the
 * target and window.
 */
export class StaticSource implements MeasurementSource {
  readonly name: string;

  constructor(
    private readonly metrics: Record<MetricId, StaticMetricValue>,
    options: { name?: string } = {}
  ) {
    this.name = options.name ?? "static";
  }

  canResolve(metric: MetricId): boolean {
    return metric in this.metrics;
  }

  async fetch({ metric, target, window }: MetricRequest): Promise<number | null> {
    const value = this.metrics[metric];
    if (value === undefined) return null;
    return typeof value === "function" ? value(target, window) : value;
  }
}
