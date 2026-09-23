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

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

type GscMetric = "clicks" | "impressions" | "ctr" | "position";

export interface GscSourceOptions {
  /** Site as registered in Search Console, e.g. "sc-domain:example.com" or "https://example.com/". */
  siteUrl: string;
  /** A service-account key JSON (added as a user on the property) or any TokenProvider. */
  auth: TokenProvider | ServiceAccountKey;
  /** Metric id -> Search Console field. Defaults to organic_clicks/impressions/ctr/position. */
  metrics?: Record<MetricId, GscMetric>;
  /** Map a run's target to the full page URL to filter on. Defaults to target.id. */
  pageUrl?: (target: TargetRef) => string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

const DEFAULT_METRICS: Record<MetricId, GscMetric> = {
  organic_clicks: "clicks",
  organic_impressions: "impressions",
  organic_ctr: "ctr",
  organic_position: "position",
};

/**
 * Google Search Console measurement source (Search Analytics API, raw REST).
 * Aggregates over the window, filtered to the run's target page. Note GSC
 * data lags ~2-3 days; schedule collection accordingly.
 */
export class GscSource implements MeasurementSource {
  readonly name = "gsc";
  private readonly auth: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly metrics: Record<MetricId, GscMetric>;

  constructor(private readonly options: GscSourceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.auth = resolveAuth(options.auth, [GSC_SCOPE], this.fetchImpl);
    this.metrics = options.metrics ?? DEFAULT_METRICS;
    this.endpoint =
      options.endpoint ??
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
        options.siteUrl
      )}/searchAnalytics/query`;
  }

  canResolve(metric: MetricId): boolean {
    return metric in this.metrics;
  }

  async fetch({ metric, target, window }: MetricRequest): Promise<number | null> {
    const field = this.metrics[metric];
    if (!field) return null;
    const page = (this.options.pageUrl ?? ((t: TargetRef) => t.id))(target);

    const token = await this.auth.getAccessToken();
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        startDate: toDateString(window.start),
        endDate: toDateString(window.end),
        dimensionFilterGroups: [
          {
            filters: [{ dimension: "page", operator: "equals", expression: page }],
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(
        `GSC query failed (${response.status}): ${await response.text()}`
      );
    }
    const data = (await response.json()) as {
      rows?: Record<GscMetric, number>[];
    };
    if (!data.rows?.length) {
      // No search traffic in the window: 0 for counts, unknown for averages.
      return field === "clicks" || field === "impressions" ? 0 : null;
    }
    return data.rows[0][field];
  }
}
