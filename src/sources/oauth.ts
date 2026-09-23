import type { TokenProvider } from "./types.js";

export interface OAuth2ClientCredentialsOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Marketo's identity endpoint takes credentials as GET query params; most others take a POST form. */
  method?: "POST" | "GET";
  extraParams?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/**
 * Plain OAuth2 client-credentials flow with token caching. Covers Marketo
 * (GET style) and Salesforce connected apps (POST form) without any SDK.
 */
export class OAuth2ClientCredentials implements TokenProvider {
  private cached?: { token: string; expiresAt: number };
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OAuth2ClientCredentialsOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - 60_000) {
      return this.cached.token;
    }
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      ...this.options.extraParams,
    });
    const method = this.options.method ?? "POST";
    const response =
      method === "GET"
        ? await this.fetchImpl(`${this.options.tokenUrl}?${params}`)
        : await this.fetchImpl(this.options.tokenUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: params,
          });
    if (!response.ok) {
      throw new Error(
        `Token request to ${this.options.tokenUrl} failed (${response.status}): ${await response.text()}`
      );
    }
    const data = (await response.json()) as {
      access_token: string;
      expires_in?: number;
    };
    this.cached = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    return this.cached.token;
  }
}
