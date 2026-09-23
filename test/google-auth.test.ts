import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GoogleServiceAccountAuth } from "../src/index.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

describe("GoogleServiceAccountAuth", () => {
  it("exchanges a signed JWT for a token and caches it until expiry", async () => {
    const calls: { url: string; body: URLSearchParams }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body as URLSearchParams,
      });
      return new Response(
        JSON.stringify({ access_token: "tok-123", expires_in: 3600 }),
        { status: 200 }
      );
    }) as typeof fetch;

    const auth = new GoogleServiceAccountAuth(
      {
        client_email: "svc@project.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      },
      ["https://www.googleapis.com/auth/analytics.readonly"],
      impl
    );

    expect(await auth.getAccessToken()).toBe("tok-123");
    expect(await auth.getAccessToken()).toBe("tok-123");
    expect(calls).toHaveLength(1); // second call served from cache

    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const assertion = calls[0].body.get("assertion")!;
    const [header, claims] = assertion.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const parsedClaims = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(parsedClaims.iss).toBe("svc@project.iam.gserviceaccount.com");
    expect(parsedClaims.scope).toContain("analytics.readonly");
  });

  it("throws a descriptive error on a failed exchange", async () => {
    const impl = (async () =>
      new Response("invalid_grant", { status: 400 })) as typeof fetch;
    const auth = new GoogleServiceAccountAuth(
      {
        client_email: "svc@project.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
      },
      ["scope"],
      impl
    );
    await expect(auth.getAccessToken()).rejects.toThrow(/400.*invalid_grant/s);
  });
});
