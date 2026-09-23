export * from "./types.js";
export type { Repository, RunFilter } from "./repository.js";
export { MemoryRepository } from "./memory-repository.js";
export { JsonFileRepository } from "./json-file-repository.js";
export { DeltaEvaluator } from "./evaluator.js";
export type { Evaluator, EvaluationResult } from "./evaluator.js";
export { computePerformance } from "./performance.js";
export { InterventionEngine } from "./engine.js";
export type {
  EngineOptions,
  RecordRunInput,
  RecordMeasurementInput,
} from "./engine.js";

// Measurement sources (integrations) — a layer over the core, never inside it.
export type {
  MeasurementSource,
  MeasurementWindow,
  MetricRequest,
  TokenProvider,
} from "./sources/types.js";
export { shiftDays } from "./sources/types.js";
export {
  GoogleServiceAccountAuth,
  type ServiceAccountKey,
} from "./sources/google-auth.js";
export {
  OAuth2ClientCredentials,
  type OAuth2ClientCredentialsOptions,
} from "./sources/oauth.js";
export {
  MarketoSource,
  type MarketoSourceOptions,
  type MarketoEmailMetric,
} from "./sources/marketo-source.js";
export {
  OutreachSource,
  type OutreachSourceOptions,
  type OutreachSequenceMetric,
} from "./sources/outreach-source.js";
export {
  SalesforceSource,
  type SalesforceSourceOptions,
  type SoqlBinding,
} from "./sources/salesforce-source.js";
export type { SqlBinding } from "./sources/types.js";
export {
  BigQuerySource,
  type BigQuerySourceOptions,
} from "./sources/bigquery-source.js";
export {
  SnowflakeSource,
  SnowflakeKeyPairAuth,
  type SnowflakeSourceOptions,
  type SnowflakeKeyPair,
} from "./sources/snowflake-source.js";
export {
  Ga4Source,
  type Ga4MetricBinding,
  type Ga4SourceOptions,
} from "./sources/ga4-source.js";
export { GscSource, type GscSourceOptions } from "./sources/gsc-source.js";
export { StaticSource } from "./sources/static-source.js";
export {
  MeasurementCollector,
  type CollectionReport,
} from "./sources/collector.js";

// MCP server building blocks — embed the engine's tools in your own MCP host.
export { McpToolServer, type McpToolDefinition } from "./mcp/protocol.js";
export { buildTools as buildMcpTools } from "./mcp/tools.js";
