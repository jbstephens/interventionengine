import { describe, expect, it } from "vitest";
import {
  MarketoSource,
  OutreachSource,
  SalesforceSource,
  type TokenProvider,
} from "../src/index.js";

const fakeAuth: TokenProvider = { getAccessToken: async () => "fake-token" };
const window = { start: "2026-09-10T00:00:00Z", end: "2026-09-17T00:00:00Z" };

type Responder = (url: string) => unknown;

function fakeFetch(respond: Responder) {
  const calls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    return new Response(JSON.stringify(respond(u)), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("MarketoSource", () => {
  const activityResponse = {
    result: [
      // 3 distinct delivered leads, 2 distinct openers (lead 1 opened twice), 1 clicker
      { leadId: 1, activityTypeId: 7, activityDate: "2026-09-11T00:00:00Z" },
      { leadId: 2, activityTypeId: 7, activityDate: "2026-09-11T00:00:00Z" },
      { leadId: 3, activityTypeId: 7, activityDate: "2026-09-11T00:00:00Z" },
      { leadId: 1, activityTypeId: 10, activityDate: "2026-09-11T01:00:00Z" },
      { leadId: 1, activityTypeId: 10, activityDate: "2026-09-12T01:00:00Z" },
      { leadId: 2, activityTypeId: 10, activityDate: "2026-09-12T02:00:00Z" },
      { leadId: 2, activityTypeId: 11, activityDate: "2026-09-12T03:00:00Z" },
      // Outside the window — must be excluded
      { leadId: 9, activityTypeId: 10, activityDate: "2026-09-25T00:00:00Z" },
    ],
    moreResult: false,
  };

  function source(impl: typeof fetch) {
    return new MarketoSource({
      baseUrl: "https://123-ABC-456.mktorest.com",
      auth: fakeAuth,
      fetchImpl: impl,
    });
  }

  it("computes distinct-lead open rate from activities scoped to the email asset", async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.includes("pagingtoken")
        ? { nextPageToken: "cursor-1" }
        : activityResponse
    );
    const value = await source(impl).fetch({
      metric: "open_rate",
      target: { id: "5721", type: "email" },
      window,
    });
    expect(value).toBeCloseTo(2 / 3);

    expect(calls[0]).toContain("pagingtoken.json?sinceDatetime=");
    const activitiesCall = new URL(calls[1]);
    expect(activitiesCall.searchParams.get("assetIds")).toBe("5721");
    expect(activitiesCall.searchParams.get("activityTypeIds")).toBe("7,10,11");
    expect(activitiesCall.searchParams.get("nextPageToken")).toBe("cursor-1");
  });

  it("follows activity paging across batches", async () => {
    let batch = 0;
    const { impl } = fakeFetch((url) => {
      if (url.includes("pagingtoken")) return { nextPageToken: "cursor-1" };
      batch += 1;
      return batch === 1
        ? {
            result: [
              { leadId: 1, activityTypeId: 7, activityDate: "2026-09-11T00:00:00Z" },
            ],
            moreResult: true,
            nextPageToken: "cursor-2",
          }
        : {
            result: [
              { leadId: 2, activityTypeId: 7, activityDate: "2026-09-11T00:00:00Z" },
            ],
            moreResult: false,
          };
    });
    const value = await source(impl).fetch({
      metric: "email_delivered",
      target: { id: "5721", type: "email" },
      window,
    });
    expect(value).toBe(2);
  });

  it("returns null rates when nothing was delivered", async () => {
    const { impl } = fakeFetch((url) =>
      url.includes("pagingtoken")
        ? { nextPageToken: "cursor-1" }
        : { result: [], moreResult: false }
    );
    const value = await source(impl).fetch({
      metric: "open_rate",
      target: { id: "5721", type: "email" },
      window,
    });
    expect(value).toBeNull();
  });
});

describe("OutreachSource", () => {
  it("derives sequence reply rate from mailings, following JSON:API pagination", async () => {
    const page2 = {
      data: [
        { attributes: { state: "delivered", repliedAt: "2026-09-12T00:00:00Z" } },
      ],
    };
    const { impl, calls } = fakeFetch((url) =>
      url.includes("page2")
        ? page2
        : {
            data: [
              { attributes: { state: "delivered", openedAt: "2026-09-11T00:00:00Z" } },
              { attributes: { state: "delivered" } },
              { attributes: { state: "bounced", bouncedAt: "2026-09-11T00:00:00Z" } },
            ],
            links: { next: "https://api.outreach.io/api/v2/mailings?page2" },
          }
    );
    const source = new OutreachSource({ auth: fakeAuth, fetchImpl: impl });
    const value = await source.fetch({
      metric: "outreach_reply_rate",
      target: { id: "88", type: "sequence" },
      window,
    });
    // 4 mailings, 1 bounced -> 3 delivered; 1 replied
    expect(value).toBeCloseTo(1 / 3);

    const first = new URL(calls[0]);
    expect(first.searchParams.get("filter[sequence][id]")).toBe("88");
    expect(first.searchParams.get("filter[deliveredAt]")).toBe(
      "2026-09-10..2026-09-17"
    );
  });
});

describe("SalesforceSource", () => {
  it("runs the bound SOQL and extracts the aggregate value", async () => {
    const { impl, calls } = fakeFetch(() => ({
      records: [{ attributes: { type: "AggregateResult" }, value: 125000 }],
    }));
    const source = new SalesforceSource({
      instanceUrl: "https://acme.my.salesforce.com",
      auth: fakeAuth,
      fetchImpl: impl,
      metrics: {
        pipeline_value: (target, w) =>
          `SELECT SUM(Amount) value FROM Opportunity WHERE AccountId = '${target.id}' ` +
          `AND CreatedDate >= ${w.start} AND CreatedDate <= ${w.end}`,
      },
    });
    const value = await source.fetch({
      metric: "pipeline_value",
      target: { id: "001ABC", type: "account" },
      window,
    });
    expect(value).toBe(125000);
    const url = new URL(calls[0]);
    expect(url.pathname).toBe("/services/data/v61.0/query");
    expect(url.searchParams.get("q")).toContain("AccountId = '001ABC'");
  });

  it("reports a null aggregate (SUM over zero rows) as 0", async () => {
    const { impl } = fakeFetch(() => ({
      records: [{ attributes: { type: "AggregateResult" }, expr0: null }],
    }));
    const source = new SalesforceSource({
      instanceUrl: "https://acme.my.salesforce.com",
      auth: fakeAuth,
      fetchImpl: impl,
      metrics: { pipeline_value: () => "SELECT SUM(Amount) FROM Opportunity" },
    });
    expect(
      await source.fetch({
        metric: "pipeline_value",
        target: { id: "001ABC", type: "account" },
        window,
      })
    ).toBe(0);
  });

  it("only resolves bound metrics", () => {
    const source = new SalesforceSource({
      instanceUrl: "https://acme.my.salesforce.com",
      auth: fakeAuth,
      metrics: { pipeline_value: () => "SELECT SUM(Amount) FROM Opportunity" },
    });
    expect(source.canResolve("pipeline_value")).toBe(true);
    expect(source.canResolve("open_rate")).toBe(false);
  });
});
