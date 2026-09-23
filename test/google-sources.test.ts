import { describe, expect, it } from "vitest";
import { Ga4Source, GscSource, type TokenProvider } from "../src/index.js";

const fakeAuth: TokenProvider = {
  getAccessToken: async () => "fake-token",
};

function fakeFetch(responseBody: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const window = { start: "2026-09-10T00:00:00Z", end: "2026-09-17T00:00:00Z" };

describe("Ga4Source", () => {
  it("builds a runReport scoped to the target page and parses the value", async () => {
    const { impl, calls } = fakeFetch({
      rows: [{ metricValues: [{ value: "1234" }] }],
    });
    const source = new Ga4Source({
      propertyId: "42",
      auth: fakeAuth,
      fetchImpl: impl,
      metrics: {
        page_views: {
          ga4Metric: "screenPageViews",
          targetFilter: (target) => ({ dimension: "pagePath", value: target.id }),
        },
      },
    });

    const value = await source.fetch({
      metric: "page_views",
      target: { id: "/blog/foo", type: "page" },
      window,
    });

    expect(value).toBe(1234);
    expect(calls[0].url).toBe(
      "https://analyticsdata.googleapis.com/v1beta/properties/42:runReport"
    );
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.dateRanges).toEqual([
      { startDate: "2026-09-10", endDate: "2026-09-17" },
    ]);
    expect(body.metrics).toEqual([{ name: "screenPageViews" }]);
    expect(body.dimensionFilter.filter).toMatchObject({
      fieldName: "pagePath",
      stringFilter: { matchType: "EXACT", value: "/blog/foo" },
    });
    expect(
      (calls[0].init.headers as Record<string, string>).authorization
    ).toBe("Bearer fake-token");
  });

  it("combines event and target filters, and reports 0 when no rows match", async () => {
    const { impl, calls } = fakeFetch({});
    const source = new Ga4Source({
      propertyId: "42",
      auth: fakeAuth,
      fetchImpl: impl,
      metrics: {
        signups: {
          ga4Metric: "eventCount",
          eventName: "sign_up",
          targetFilter: (target) => ({
            dimension: "landingPage",
            value: target.id,
          }),
        },
      },
    });

    const value = await source.fetch({
      metric: "signups",
      target: { id: "/pricing", type: "page" },
      window,
    });

    expect(value).toBe(0);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.dimensionFilter.andGroup.expressions).toHaveLength(2);
  });

  it("only resolves configured metrics", async () => {
    const source = new Ga4Source({
      propertyId: "42",
      auth: fakeAuth,
      metrics: { page_views: { ga4Metric: "screenPageViews" } },
    });
    expect(source.canResolve("page_views")).toBe(true);
    expect(source.canResolve("open_rate")).toBe(false);
  });
});

describe("GscSource", () => {
  it("queries search analytics filtered to the target page", async () => {
    const { impl, calls } = fakeFetch({
      rows: [{ clicks: 57, impressions: 900, ctr: 0.063, position: 8.2 }],
    });
    const source = new GscSource({
      siteUrl: "sc-domain:example.com",
      auth: fakeAuth,
      fetchImpl: impl,
      pageUrl: (target) => `https://example.com${target.id}`,
    });

    const value = await source.fetch({
      metric: "organic_clicks",
      target: { id: "/blog/foo", type: "page" },
      window,
    });

    expect(value).toBe(57);
    expect(calls[0].url).toContain(encodeURIComponent("sc-domain:example.com"));
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      startDate: "2026-09-10",
      endDate: "2026-09-17",
    });
    expect(body.dimensionFilterGroups[0].filters[0]).toEqual({
      dimension: "page",
      operator: "equals",
      expression: "https://example.com/blog/foo",
    });
  });

  it("reports 0 clicks but null ctr when the page had no search traffic", async () => {
    const { impl } = fakeFetch({});
    const source = new GscSource({
      siteUrl: "https://example.com/",
      auth: fakeAuth,
      fetchImpl: impl,
    });
    const target = { id: "https://example.com/new-page", type: "page" };
    expect(await source.fetch({ metric: "organic_clicks", target, window })).toBe(0);
    expect(await source.fetch({ metric: "organic_ctr", target, window })).toBeNull();
  });
});
