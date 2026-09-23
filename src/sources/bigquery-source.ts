import type { MetricId } from "../types.js";
import {
  resolveAuth,
  type ServiceAccountKey,
  type TokenProvider,
} from "./google-auth.js";
import type {
  MeasurementSource,
  MetricRequest,
  SqlBinding,
} from "./types.js";

const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";

export interface BigQuerySourceOptions {
  projectId: string;
  /** A service-account key JSON (BigQuery Job User + Data Viewer) or any TokenProvider. */
  auth: TokenProvider | ServiceAccountKey;
  /** Metric id -> SQL builder. Each query returns one row; its first column is the value. */
  metrics: Record<MetricId, SqlBinding>;
  /** Dataset location (e.g. "US", "EU"); usually optional. */
  location?: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  /** Delay between polls for long-running queries; injectable for tests. */
  pollDelayMs?: number;
}

interface QueryResponse {
  jobComplete?: boolean;
  jobReference?: { jobId: string; location?: string };
  rows?: { f: { v: string | null }[] }[];
}

/**
 * BigQuery measurement source: each metric is an arbitrary Standard SQL
 * query (jobs.query REST API — no SDK). Aggregates over zero rows, or a
 * NULL aggregate, report 0. Queries that outlive the initial 30s wait are
 * polled to completion.
 */
export class BigQuerySource implements MeasurementSource {
  readonly name = "bigquery";
  private readonly auth: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly pollDelayMs: number;

  constructor(private readonly options: BigQuerySourceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.auth = resolveAuth(options.auth, [BIGQUERY_SCOPE], this.fetchImpl);
    this.endpoint =
      options.endpoint ??
      `https://bigquery.googleapis.com/bigquery/v2/projects/${options.projectId}/queries`;
    this.pollDelayMs = options.pollDelayMs ?? 1000;
  }

  canResolve(metric: MetricId): boolean {
    return metric in this.options.metrics;
  }

  async fetch({ metric, target, window }: MetricRequest): Promise<number | null> {
    const binding = this.options.metrics[metric];
    if (!binding) return null;
    const query = binding(target, window);

    const token = await this.auth.getAccessToken();
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query,
        useLegacySql: false,
        timeoutMs: 30_000,
        ...(this.options.location ? { location: this.options.location } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(
        `BigQuery query failed (${response.status}): ${await response.text()}`
      );
    }
    let data = (await response.json()) as QueryResponse;

    for (let attempt = 0; !data.jobComplete && attempt < 10; attempt++) {
      if (!data.jobReference) {
        throw new Error("BigQuery job incomplete and no jobReference returned");
      }
      await sleep(this.pollDelayMs);
      const params = new URLSearchParams({ timeoutMs: "30000" });
      if (data.jobReference.location) {
        params.set("location", data.jobReference.location);
      }
      const poll = await this.fetchImpl(
        `${this.endpoint}/${data.jobReference.jobId}?${params}`,
        { headers }
      );
      if (!poll.ok) {
        throw new Error(
          `BigQuery poll failed (${poll.status}): ${await poll.text()}`
        );
      }
      data = (await poll.json()) as QueryResponse;
    }
    if (!data.jobComplete) {
      throw new Error(`BigQuery query for metric "${metric}" did not complete`);
    }

    const value = data.rows?.[0]?.f?.[0]?.v;
    if (value === undefined || value === null) return 0; // no rows / NULL aggregate
    return Number(value);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
