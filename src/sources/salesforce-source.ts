import type { MetricId } from "../types.js";
import { OAuth2ClientCredentials } from "./oauth.js";
import type {
  MeasurementSource,
  MetricRequest,
  SqlBinding,
  TokenProvider,
} from "./types.js";

/**
 * Builds the SOQL for one metric — the same shape as the warehouse sources'
 * SqlBinding, e.g.:
 *
 *   pipeline_value: (t, w) =>
 *     `SELECT SUM(Amount) value FROM Opportunity
 *      WHERE AccountId = '${t.id}' AND CreatedDate >= ${w.start} AND CreatedDate <= ${w.end}`
 */
export type SoqlBinding = SqlBinding;

export interface SalesforceSourceOptions {
  /** e.g. "https://yourorg.my.salesforce.com" */
  instanceUrl: string;
  /** A TokenProvider, or connected-app credentials for the client-credentials flow. */
  auth: TokenProvider | { clientId: string; clientSecret: string };
  /**
   * Metric id -> SOQL builder. Salesforce outcome definitions are org-specific
   * (stage names, record types, custom fields), so bindings are explicit
   * queries rather than a canned metric list.
   */
  metrics: Record<MetricId, SoqlBinding>;
  /** API version; defaults to v61.0. */
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Salesforce measurement source: each metric is a SOQL aggregate query.
 * Typical outcome metrics: opportunities created for an account, pipeline
 * amount generated, closed-won value, stage progressions, activities logged.
 * A null aggregate (e.g. SUM over zero rows) is reported as 0.
 */
export class SalesforceSource implements MeasurementSource {
  readonly name = "salesforce";
  private readonly auth: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly queryUrl: string;

  constructor(private readonly options: SalesforceSourceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.queryUrl = `${options.instanceUrl}/services/data/${
      options.apiVersion ?? "v61.0"
    }/query`;
    this.auth =
      "getAccessToken" in options.auth
        ? options.auth
        : new OAuth2ClientCredentials({
            tokenUrl: `${options.instanceUrl}/services/oauth2/token`,
            clientId: options.auth.clientId,
            clientSecret: options.auth.clientSecret,
            fetchImpl: this.fetchImpl,
          });
  }

  canResolve(metric: MetricId): boolean {
    return metric in this.options.metrics;
  }

  async fetch({ metric, target, window }: MetricRequest): Promise<number | null> {
    const binding = this.options.metrics[metric];
    if (!binding) return null;
    const soql = binding(target, window);

    const token = await this.auth.getAccessToken();
    const response = await this.fetchImpl(
      `${this.queryUrl}?q=${encodeURIComponent(soql)}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    if (!response.ok) {
      throw new Error(
        `Salesforce query failed (${response.status}): ${await response.text()}`
      );
    }
    const data = (await response.json()) as {
      records?: Record<string, unknown>[];
    };
    if (!data.records?.length) return 0;

    const record = data.records[0];
    const value = Object.entries(record).find(
      ([key, v]) => key !== "attributes" && (typeof v === "number" || v === null)
    )?.[1] as number | null | undefined;
    if (value === undefined) {
      throw new Error(
        `Salesforce query for metric "${metric}" returned no numeric aggregate field: ${soql}`
      );
    }
    return value ?? 0; // SUM() over zero rows is null — report it as 0
  }
}
