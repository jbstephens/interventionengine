import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BigQuerySource,
  SnowflakeKeyPairAuth,
  SnowflakeSource,
  type TokenProvider,
} from "../src/index.js";

const fakeAuth: TokenProvider = { getAccessToken: async () => "fake-token" };
const window = { start: "2026-09-10T00:00:00Z", end: "2026-09-17T00:00:00Z" };
const target = { id: "acct_42", type: "account" };

const trialStarts = (t: { id: string }, w: { start: string; end: string }) =>
  `SELECT COUNT(*) FROM events WHERE account_id = '${t.id}' ` +
  `AND name = 'trial_start' AND ts BETWEEN '${w.start}' AND '${w.end}'`;

function fakeFetch(respond: (url: string, call: number) => { status?: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const { status = 200, body } = respond(String(url), calls.length);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe("BigQuerySource", () => {
  it("runs the bound SQL via jobs.query and parses the value", async () => {
    const { impl, calls } = fakeFetch(() => ({
      body: { jobComplete: true, rows: [{ f: [{ v: "17" }] }] },
    }));
    const source = new BigQuerySource({
      projectId: "acme-analytics",
      auth: fakeAuth,
      fetchImpl: impl,
      metrics: { trial_starts: trialStarts },
    });
    const value = await source.fetch({ metric: "trial_starts", target, window });
    expect(value).toBe(17);

    expect(calls[0].url).toBe(
      "https://bigquery.googleapis.com/bigquery/v2/projects/acme-analytics/queries"
    );
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.useLegacySql).toBe(false);
    expect(body.query).toContain("account_id = 'acct_42'");
  });

  it("polls incomplete jobs to completion", async () => {
    const { impl, calls } = fakeFetch((_url, call) =>
      call === 1
        ? { body: { jobComplete: false, jobReference: { jobId: "job-9", location: "EU" } } }
        : { body: { jobComplete: true, rows: [{ f: [{ v: "3.5" }] }] } }
    );
    const source = new BigQuerySource({
      projectId: "acme-analytics",
      auth: fakeAuth,
      fetchImpl: impl,
      pollDelayMs: 0,
      metrics: { trial_starts: trialStarts },
    });
    expect(await source.fetch({ metric: "trial_starts", target, window })).toBe(3.5);
    expect(calls[1].url).toContain("/queries/job-9?");
    expect(calls[1].url).toContain("location=EU");
  });

  it("reports no rows or a NULL aggregate as 0", async () => {
    const { impl } = fakeFetch((_url, call) => ({
      body:
        call === 1
          ? { jobComplete: true }
          : { jobComplete: true, rows: [{ f: [{ v: null }] }] },
    }));
    const source = new BigQuerySource({
      projectId: "acme-analytics",
      auth: fakeAuth,
      fetchImpl: impl,
      metrics: { trial_starts: trialStarts },
    });
    expect(await source.fetch({ metric: "trial_starts", target, window })).toBe(0);
    expect(await source.fetch({ metric: "trial_starts", target, window })).toBe(0);
  });
});

describe("SnowflakeSource", () => {
  it("submits the statement with session context and parses the value", async () => {
    const { impl, calls } = fakeFetch(() => ({
      body: { data: [["125000.50"]] },
    }));
    const source = new SnowflakeSource({
      account: "myorg-account1",
      auth: fakeAuth,
      warehouse: "ANALYTICS_WH",
      database: "MARKETING",
      fetchImpl: impl,
      metrics: { trial_starts: trialStarts },
    });
    const value = await source.fetch({ metric: "trial_starts", target, window });
    expect(value).toBe(125000.5);

    expect(calls[0].url).toBe(
      "https://myorg-account1.snowflakecomputing.com/api/v2/statements"
    );
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.warehouse).toBe("ANALYTICS_WH");
    expect(body.database).toBe("MARKETING");
    expect(body.statement).toContain("acct_42");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["X-Snowflake-Authorization-Token-Type"]).toBe("OAUTH");
  });

  it("polls 202 responses via the statement handle", async () => {
    const { impl, calls } = fakeFetch((_url, call) =>
      call === 1
        ? { status: 202, body: { statementHandle: "handle-7" } }
        : { body: { data: [["9"]] } }
    );
    const source = new SnowflakeSource({
      account: "myorg-account1",
      auth: fakeAuth,
      fetchImpl: impl,
      pollDelayMs: 0,
      metrics: { trial_starts: trialStarts },
    });
    expect(await source.fetch({ metric: "trial_starts", target, window })).toBe(9);
    expect(calls[1].url).toContain("/api/v2/statements/handle-7");
  });

  it("reports an empty result set as 0", async () => {
    const { impl } = fakeFetch(() => ({ body: { data: [] } }));
    const source = new SnowflakeSource({
      account: "myorg-account1",
      auth: fakeAuth,
      fetchImpl: impl,
      metrics: { trial_starts: trialStarts },
    });
    expect(await source.fetch({ metric: "trial_starts", target, window })).toBe(0);
  });
});

describe("SnowflakeKeyPairAuth", () => {
  it("mints a Snowflake-shaped JWT with fingerprinted issuer", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const auth = new SnowflakeKeyPairAuth("myorg-account1", {
      user: "svc_intervention",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    });
    const token = await auth.getAccessToken();
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString()
    );
    expect(claims.sub).toBe("MYORG-ACCOUNT1.SVC_INTERVENTION");
    expect(claims.iss).toMatch(/^MYORG-ACCOUNT1\.SVC_INTERVENTION\.SHA256:.+/);
    expect(claims.exp - claims.iat).toBe(3540);
    // Cached on second call.
    expect(await auth.getAccessToken()).toBe(token);
  });
});
