import type { MetricId, TargetRef } from "../types.js";

/** Time window a source should aggregate over. ISO datetimes; adapters may truncate to dates. */
export interface MeasurementWindow {
  start: string;
  end: string;
}

export interface MetricRequest {
  metric: MetricId;
  target: TargetRef;
  window: MeasurementWindow;
}

/**
 * A pluggable measurement integration (GA4, Search Console, Marketo, ...).
 *
 * A source declares which metric ids it can resolve and, given a metric, a
 * target, and a window, returns one observed value — or null when it has no
 * answer (insufficient data, metric not applicable to this target). The
 * engine core never knows sources exist; the MeasurementCollector bridges
 * them into ordinary Measurement records.
 */
export interface MeasurementSource {
  readonly name: string;
  canResolve(metric: MetricId): boolean;
  fetch(request: MetricRequest): Promise<number | null>;
}

/** Anything that can mint an OAuth bearer token. */
export interface TokenProvider {
  getAccessToken(): Promise<string>;
}

export function shiftDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

/** YYYY-MM-DD, as Google reporting APIs expect. */
export function toDateString(iso: string): string {
  return iso.slice(0, 10);
}
