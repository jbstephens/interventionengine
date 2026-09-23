import type { MetricId, TargetRef } from "../types.js";
import {
  resolveAuth,
  type ServiceAccountKey,
  type TokenProvider,
} from "./google-auth.js";
import {
  toDateString,
  type MeasurementSource,
  type MetricRequest,
} from "./types.js";

const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

export interface Ga4DimensionFilter {
  dimension: string;
  value: string;
  /** GA4 stringFilter matchType; defaults to EXACT. */
  matchType?: "EXACT" | "BEGINS_WITH" | "ENDS_WITH" | "CONTAINS" | "FULL_REGEXP";
}

/**
 * Binds one of your metric ids to a GA4 query.
 *
 * Examples:
 *   page_views: { ga4Metric: "screenPageViews",
 *                 targetFilter: (t) => ({ dimension: "pagePath", value: t.id }) }
 *   signups:    { ga4Metric: "eventCount", eventName: "sign_up" }
 */
export interface Ga4MetricBinding {
  /** GA4 metric name: "screenPageViews", "sessions", "eventCount", "conversions", ... */
  ga4Metric: string;
  /** Restrict eventCount-style metrics to one event name. */
  eventName?: string;
  /** Scope the query to the run's target (e.g. its pagePath). Return null for a property-wide value. */
  targetFilter?: (target: TargetRef) => Ga4DimensionFilter | null;
}

export interface Ga4SourceOptions {
  /** Numeric GA4 property id, e.g. "421337009". */
  propertyId: string;
  /** A service-account key JSON (needs Viewer on the property) or any TokenProvider. */
  auth: TokenProvider | ServiceAccountKey;
  metrics: Record<MetricId, Ga4MetricBinding>;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

/**
 * Google Analytics 4 measurement source (Data API v1beta, raw REST — no SDK).
 * Values are aggregated over the requested window; a window with no matching
 * rows reports 0, since "nothing happened" is a real observation for counts.
 */
export class Ga4Source implements MeasurementSource {
  readonly name = "ga4";
  private readonly auth: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(private readonly options: Ga4SourceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.auth = resolveAuth(options.auth, [GA4_SCOPE], this.fetchImpl);
    this.endpoint =
      options.endpoint ??
      `https://analyticsdata.googleapis.com/v1beta/properties/${options.propertyId}:runReport`;
  }

  canResolve(metric: MetricId): boolean {
    return metric in this.options.metrics;
  }

  async fetch({ metric, target, window }: MetricRequest): Promise<number | null> {
    const binding = this.options.metrics[metric];
    if (!binding) return null;

    const filters: unknown[] = [];
    if (binding.eventName) {
      filters.push({
        filter: {
          fieldName: "eventName",
          stringFilter: { matchType: "EXACT", value: binding.eventName },
        },
      });
    }
    const targetFilter = binding.targetFilter?.(target) ?? null;
    if (targetFilter) {
      filters.push({
        filter: {
          fieldName: targetFilter.dimension,
          stringFilter: {
            matchType: targetFilter.matchType ?? "EXACT",
            value: targetFilter.value,
          },
        },
      });
    }

    const body: Record<string, unknown> = {
      dateRanges: [
        { startDate: toDateString(window.start), endDate: toDateString(window.end) },
      ],
      metrics: [{ name: binding.ga4Metric }],
    };
    if (filters.length === 1) body.dimensionFilter = filters[0];
    if (filters.length > 1) body.dimensionFilter = { andGroup: { expressions: filters } };

    const token = await this.auth.getAccessToken();
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `GA4 runReport failed (${response.status}): ${await response.text()}`
      );
    }
    const data = (await response.json()) as {
      rows?: { metricValues: { value: string }[] }[];
    };
    if (!data.rows?.length) return 0;
    return Number(data.rows[0].metricValues[0].value);
  }
}
