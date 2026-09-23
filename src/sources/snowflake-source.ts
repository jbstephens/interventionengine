import { createHash, createPublicKey, createSign } from "node:crypto";
import type { MetricId } from "../types.js";
import type {
  MeasurementSource,
  MetricRequest,
  SqlBinding,
  TokenProvider,
} from "./types.js";

export interface SnowflakeKeyPair {
  /** Snowflake user the key pair is registered to. */
  user: string;
  /** PKCS#8 PEM private key whose public key is set on the user. */
  privateKey: string;
}

/**
 * Snowflake key-pair JWT auth: iss is ACCOUNT.USER.SHA256:<public-key-
 * fingerprint>, sub is ACCOUNT.USER, signed RS256 — Snowflake's standard
 * for programmatic access. Tokens are minted locally, cached ~55 minutes.
 */
export class SnowflakeKeyPairAuth implements TokenProvider {
  private cached?: { token: string; expiresAt: number };

  constructor(
    private readonly account: string,
    private readonly keyPair: SnowflakeKeyPair
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.expiresAt - 60_000) {
      return this.cached.token;
    }
    const publicKeyDer = createPublicKey(this.keyPair.privateKey).export({
      type: "spki",
      format: "der",
    });
    const fingerprint = createHash("sha256").update(publicKeyDer).digest("base64");
    const qualifiedUser = `${this.account.toUpperCase()}.${this.keyPair.user.toUpperCase()}`;

    const now = Math.floor(Date.now() / 1000);
    const encode = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url");
    const unsigned =
      `${encode({ alg: "RS256", typ: "JWT" })}.` +
      encode({
        iss: `${qualifiedUser}.SHA256:${fingerprint}`,
        sub: qualifiedUser,
        iat: now,
        exp: now + 3540,
      });
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    const token = `${unsigned}.${signer
      .sign(this.keyPair.privateKey)
      .toString("base64url")}`;

    this.cached = { token, expiresAt: Date.now() + 3540 * 1000 };
    return token;
  }
}

export interface SnowflakeSourceOptions {
  /** Account identifier, e.g. "myorg-account1" (as in the account URL). */
  account: string;
  /** A key pair (recommended) or any TokenProvider (OAuth/PAT — set tokenType to match). */
  auth: TokenProvider | SnowflakeKeyPair;
  /** Metric id -> SQL builder. Each query returns one row; its first column is the value. */
  metrics: Record<MetricId, SqlBinding>;
  warehouse?: string;
  database?: string;
  schema?: string;
  role?: string;
  /** X-Snowflake-Authorization-Token-Type; defaults to KEYPAIR_JWT for key pairs, OAUTH otherwise. */
  tokenType?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Delay between polls for statements still executing; injectable for tests. */
  pollDelayMs?: number;
}

interface StatementResponse {
  statementHandle?: string;
  data?: (string | null)[][];
}

/**
 * Snowflake measurement source: each metric is an arbitrary SQL query run
 * through the SQL API v2 (raw REST — no SDK). Aggregates over zero rows,
 * or a NULL aggregate, report 0. Statements still executing (HTTP 202) are
 * polled to completion.
 */
export class SnowflakeSource implements MeasurementSource {
  readonly name = "snowflake";
  private readonly auth: TokenProvider;
  private readonly tokenType: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly pollDelayMs: number;

  constructor(private readonly options: SnowflakeSourceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl =
      options.baseUrl ?? `https://${options.account}.snowflakecomputing.com`;
    this.pollDelayMs = options.pollDelayMs ?? 1000;
    if ("getAccessToken" in options.auth) {
      this.auth = options.auth;
      this.tokenType = options.tokenType ?? "OAUTH";
    } else {
      this.auth = new SnowflakeKeyPairAuth(options.account, options.auth);
      this.tokenType = options.tokenType ?? "KEYPAIR_JWT";
    }
  }

  canResolve(metric: MetricId): boolean {
    return metric in this.options.metrics;
  }

  async fetch({ metric, target, window }: MetricRequest): Promise<number | null> {
    const binding = this.options.metrics[metric];
    if (!binding) return null;
    const statement = binding(target, window);

    const token = await this.auth.getAccessToken();
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
      "X-Snowflake-Authorization-Token-Type": this.tokenType,
    };
    let response = await this.fetchImpl(`${this.baseUrl}/api/v2/statements`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        statement,
        timeout: 60,
        ...(this.options.warehouse ? { warehouse: this.options.warehouse } : {}),
        ...(this.options.database ? { database: this.options.database } : {}),
        ...(this.options.schema ? { schema: this.options.schema } : {}),
        ...(this.options.role ? { role: this.options.role } : {}),
      }),
    });

    for (let attempt = 0; response.status === 202 && attempt < 10; attempt++) {
      const { statementHandle } = (await response.json()) as StatementResponse;
      if (!statementHandle) {
        throw new Error("Snowflake returned 202 without a statementHandle");
      }
      await sleep(this.pollDelayMs);
      response = await this.fetchImpl(
        `${this.baseUrl}/api/v2/statements/${statementHandle}`,
        { headers }
      );
    }
    if (!response.ok) {
      throw new Error(
        `Snowflake statement failed (${response.status}): ${await response.text()}`
      );
    }

    const data = (await response.json()) as StatementResponse;
    const value = data.data?.[0]?.[0];
    if (value === undefined || value === null) return 0; // no rows / NULL aggregate
    return Number(value);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
