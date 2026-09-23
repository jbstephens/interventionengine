import type { MetricId } from "../types.js";
import { OAuth2ClientCredentials } from "./oauth.js";
import type {
  MeasurementSource,
  MetricRequest,
  TokenProvider,
} from "./types.js";

/** Marketo activity type ids for email engagement. */
const ACTIVITY_TYPES = { delivered: 7, open: 10, click: 11 } as const;

export type MarketoEmailMetric =
  | "delivered"
  | "opens"
  | "clicks"
  | "open_rate"
  | "click_rate";

export interface MarketoSourceOptions {
  /** REST base URL for the instance, e.g. "https://123-ABC-456.mktorest.com". */
  baseUrl: string;
  /** An API-only user's custom service credentials, or any TokenProvider. */
  auth: TokenProvider | { clientId: string; clientSecret: string };
  /**
   * Metric id -> email metric. Defaults to email_delivered / email_opens /
   * email_clicks / open_rate / click_rate. Rates are distinct-lead counts
   * over distinct delivered leads.
   */
  metrics?: Record<MetricId, MarketoEmailMetric>;
  fetchImpl?: typeof fetch;
}

const DEFAULT_METRICS: Record<MetricId, MarketoEmailMetric> = {
  email_delivered: "delivered",
  email_opens: "opens",
  email_clicks: "clicks",
  open_rate: "open_rate",
  click_rate: "click_rate",
};

interface Activity {
  leadId: number;
  activityTypeId: number;
  activityDate: string;
}

/**
 * Marketo measurement source for email targets, where target.id is the
 * Marketo email asset id. Counts delivered/open/click activities for that
 * asset over the window via the activities API (deduplicated by lead, the
 * way Marketo email reports count), and derives open/click rates.
 */
export class MarketoSource implements MeasurementSource {
  readonly name = "marketo";
  private readonly auth: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly metrics: Record<MetricId, MarketoEmailMetric>;

  constructor(private readonly options: MarketoSourceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.metrics = options.metrics ?? DEFAULT_METRICS;
    this.auth =
      "getAccessToken" in options.auth
        ? options.auth
        : new OAuth2ClientCredentials({
            tokenUrl: `${options.baseUrl}/identity/oauth/token`,
            clientId: options.auth.clientId,
            clientSecret: options.auth.clientSecret,
            method: "GET",
            fetchImpl: this.fetchImpl,
          });
  }

  canResolve(metric: MetricId): boolean {
    return metric in this.metrics;
  }

  async fetch({ metric, target, window }: MetricRequest): Promise<number | null> {
    const kind = this.metrics[metric];
    if (!kind) return null;

    // The API only supports a "since" cursor; the window's end is enforced here.
    const activities = (await this.fetchActivities(target.id, window.start)).filter(
      (a) => a.activityDate <= window.end
    );
    const distinctLeads = (typeId: number) =>
      new Set(
        activities
          .filter((a) => a.activityTypeId === typeId)
          .map((a) => a.leadId)
      ).size;

    const delivered = distinctLeads(ACTIVITY_TYPES.delivered);
    const opens = distinctLeads(ACTIVITY_TYPES.open);
    const clicks = distinctLeads(ACTIVITY_TYPES.click);

    switch (kind) {
      case "delivered":
        return delivered;
      case "opens":
        return opens;
      case "clicks":
        return clicks;
      case "open_rate":
        return delivered > 0 ? opens / delivered : null;
      case "click_rate":
        return delivered > 0 ? clicks / delivered : null;
    }
  }

  private async fetchActivities(
    emailAssetId: string,
    since: string
  ): Promise<Activity[]> {
    const token = await this.auth.getAccessToken();
    const headers = { authorization: `Bearer ${token}` };

    const tokenResponse = await this.fetchImpl(
      `${this.options.baseUrl}/rest/v1/activities/pagingtoken.json?sinceDatetime=${encodeURIComponent(since)}`,
      { headers }
    );
    if (!tokenResponse.ok) {
      throw new Error(
        `Marketo paging token failed (${tokenResponse.status}): ${await tokenResponse.text()}`
      );
    }
    let nextPageToken = ((await tokenResponse.json()) as { nextPageToken: string })
      .nextPageToken;

    const activities: Activity[] = [];
    let moreResult = true;
    while (moreResult) {
      const params = new URLSearchParams({
        nextPageToken,
        activityTypeIds: Object.values(ACTIVITY_TYPES).join(","),
        assetIds: emailAssetId,
      });
      const response = await this.fetchImpl(
        `${this.options.baseUrl}/rest/v1/activities.json?${params}`,
        { headers }
      );
      if (!response.ok) {
        throw new Error(
          `Marketo activities failed (${response.status}): ${await response.text()}`
        );
      }
      const data = (await response.json()) as {
        result?: Activity[];
        moreResult?: boolean;
        nextPageToken?: string;
      };
      activities.push(...(data.result ?? []));
      moreResult = data.moreResult ?? false;
      if (data.nextPageToken) nextPageToken = data.nextPageToken;
    }
    return activities;
  }
}
