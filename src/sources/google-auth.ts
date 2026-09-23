import { createSign } from "node:crypto";
import type { TokenProvider } from "./types.js";

export type { TokenProvider };

/** The relevant subset of a Google service-account key JSON file. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/**
 * Service-account auth via a self-signed JWT exchanged for an access token —
 * the standard Google flow, implemented with node:crypto so no SDK is needed.
 * Tokens are cached until shortly before expiry.
 */
export class GoogleServiceAccountAuth implements TokenProvider {
  private cached?: { token: string; expiresAt: number };

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly scopes: string[],
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - 60_000) {
      return this.cached.token;
    }
    const tokenUri = this.key.token_uri ?? "https://oauth2.googleapis.com/token";
    const now = Math.floor(Date.now() / 1000);
    const encode = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url");
    const unsigned =
      `${encode({ alg: "RS256", typ: "JWT" })}.` +
      encode({
        iss: this.key.client_email,
        scope: this.scopes.join(" "),
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      });
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    const assertion = `${unsigned}.${signer
      .sign(this.key.private_key)
      .toString("base64url")}`;

    const response = await this.fetchImpl(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Google token exchange failed (${response.status}): ${await response.text()}`
      );
    }
    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.cached = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return this.cached.token;
  }
}

/** Accepts either a ready TokenProvider or a raw service-account key. */
export function resolveAuth(
  auth: TokenProvider | ServiceAccountKey,
  scopes: string[],
  fetchImpl: typeof fetch = fetch
): TokenProvider {
  if ("getAccessToken" in auth) return auth;
  return new GoogleServiceAccountAuth(auth, scopes, fetchImpl);
}
