import type { MetricId } from "../types.js";
import type {
  MeasurementSource,
  MetricRequest,
  TokenProvider,
} from "./types.js";
import { toDateString } from "./types.js";

export type OutreachSequenceMetric =
  | "delivered"
  | "open_rate"
  | "click_rate"
  | "reply_rate"
  | "bounce_rate";

export interface OutreachSourceOptions {
  /** A TokenProvider or a static access token (Outreach rotates refresh tokens, so refresh management stays with the host). */
  auth: TokenProvider | { accessToken: string };
  /**
   * Metric id -> sequence metric. Defaults to outreach_delivered /
   * outreach_open_rate / outreach_click_rate / outreach_reply_rate /
   * outreach_bounce_rate. Rates are per delivered mailing.
   */
  metrics?: Record<MetricId, OutreachSequenceMetric>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_METRICS: Record<MetricId, OutreachSequenceMetric> = {
  outreach_delivered: "delivered",
  outreach_open_rate: "open_rate",
  outreach_click_rate: "click_rate",
  outreach_reply_rate: "reply_rate",
  outreach_bounce_rate: "bounce_rate",
};

interface MailingAttributes {
  state?: string;
  bouncedAt?: string | null;
  openedAt?: string | null;
  clickedAt?: string | null;
  repliedAt?: string | null;
  openCount?: number;
  clickCount?: number;
}

/**
 * Outreach measurement source for sequence targets, where target.id is the
 * Outreach sequence id. Pages the mailings delivered by that sequence over
 * the window (JSON:API) and derives delivery/open/click/reply/bounce stats.
 */
export class OutreachSource implements MeasurementSource {
  readonly name = "outreach";
  private readonly auth: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly metrics: Record<MetricId, OutreachSequenceMetric>;

  constructor(options: OutreachSourceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.outreach.io/api/v2";
    this.metrics = options.metrics ?? DEFAULT_METRICS;
    this.auth =
      "getAccessToken" in options.auth
        ? options.auth
        : staticToken(options.auth.accessToken);
  }

  canResolve(metric: MetricId): boolean {
    return metric in this.metrics;
  }

  async fetch({ metric, target, window }: MetricRequest): Promise<number | null> {
    const kind = this.metrics[metric];
    if (!kind) return null;

    const mailings = await this.fetchMailings(target.id, window);
    const total = mailings.length;
    const bounced = mailings.filter(
      (m) => m.bouncedAt || m.state === "bounced"
    ).length;
    const delivered = total - bounced;
    const opened = mailings.filter(
      (m) => m.openedAt || (m.openCount ?? 0) > 0
    ).length;
    const clicked = mailings.filter(
      (m) => m.clickedAt || (m.clickCount ?? 0) > 0
    ).length;
    const replied = mailings.filter((m) => m.repliedAt).length;

    switch (kind) {
      case "delivered":
        return delivered;
      case "open_rate":
        return delivered > 0 ? opened / delivered : null;
      case "click_rate":
        return delivered > 0 ? clicked / delivered : null;
      case "reply_rate":
        return delivered > 0 ? replied / delivered : null;
      case "bounce_rate":
        return total > 0 ? bounced / total : null;
    }
  }

  private async fetchMailings(
    sequenceId: string,
    window: { start: string; end: string }
  ): Promise<MailingAttributes[]> {
    const token = await this.auth.getAccessToken();
    const mailings: MailingAttributes[] = [];
    let url: string | null =
      `${this.baseUrl}/mailings?` +
      new URLSearchParams({
        "filter[sequence][id]": sequenceId,
        "filter[deliveredAt]": `${toDateString(window.start)}..${toDateString(window.end)}`,
        "page[size]": "250",
      });

    while (url) {
      const response = await this.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/vnd.api+json",
        },
      });
      if (!response.ok) {
        throw new Error(
          `Outreach mailings failed (${response.status}): ${await response.text()}`
        );
      }
      const data = (await response.json()) as {
        data?: { attributes: MailingAttributes }[];
        links?: { next?: string };
      };
      mailings.push(...(data.data ?? []).map((d) => d.attributes));
      url = data.links?.next ?? null;
    }
    return mailings;
  }
}

function staticToken(accessToken: string): TokenProvider {
  return { getAccessToken: async () => accessToken };
}
