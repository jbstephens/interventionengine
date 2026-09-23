import type { InterventionEngine } from "../engine.js";
import type { RunStatus } from "../types.js";
import type { McpToolDefinition } from "./protocol.js";

const RUN_STATUSES = ["recommended", "accepted", "rejected", "applied", "expired"];

/**
 * Exposes the engine's API surface as MCP tools so any MCP client (Claude,
 * other assistants, agent frameworks) can run the full loop: inspect the
 * taxonomy, pull evidence, write recommendations back, record what happened.
 *
 * The descriptions encode the product contract: a recommendation must
 * resolve to a KNOWN intervention id from list_interventions — an LLM
 * consumer reasons freely but cannot invent actions.
 */
export function buildTools(engine: InterventionEngine): McpToolDefinition[] {
  return [
    {
      name: "list_interventions",
      description:
        "List the defined intervention taxonomy (latest version of each). This is the bounded set of actions the system may recommend — any recommendation you make MUST use one of these intervention ids. Optionally filter to interventions applicable to a target type.",
      inputSchema: {
        type: "object",
        properties: {
          targetType: {
            type: "string",
            description: "Only interventions applicable to this target type (e.g. \"email\", \"page\")",
          },
        },
      },
      handler: (args) =>
        engine.listInterventions({ targetType: args.targetType as string | undefined }),
    },
    {
      name: "define_intervention",
      description:
        "Define a new intervention, or create a new version of an existing one (reusing an id increments the version; history stays pinned to old versions). Use sparingly — the taxonomy is meant to be stable and bounded; measurement quality depends on intervention categories not mutating casually.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Stable kebab-case id, e.g. \"email-subject-strategy\"" },
          name: { type: "string" },
          description: { type: "string" },
          targetTypes: { type: "array", items: { type: "string" } },
          successMetrics: { type: "array", items: { type: "string" } },
          expectedDirection: { type: "string", enum: ["increase", "decrease"] },
          measurementWindowDays: { type: "number" },
        },
        required: ["id", "name", "targetTypes", "successMetrics"],
      },
      handler: (args) =>
        engine.defineIntervention({
          id: args.id as string,
          name: args.name as string,
          description: args.description as string | undefined,
          targetTypes: args.targetTypes as string[],
          successMetrics: args.successMetrics as string[],
          expectedDirection: args.expectedDirection as "increase" | "decrease" | undefined,
          measurementWindowDays: args.measurementWindowDays as number | undefined,
        }),
    },
    {
      name: "get_intervention",
      description:
        "Get one intervention definition — the latest version, or a specific version as pinned by a historical run.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          version: { type: "number" },
        },
        required: ["id"],
      },
      handler: (args) =>
        engine.getIntervention(args.id as string, args.version as number | undefined),
    },
    {
      name: "record_run",
      description:
        "Record that an intervention was recommended or applied to a target. The interventionId must come from list_interventions. Include context (the conditions that led to this selection — campaign type, audience, page type, ...), a reasonSelected, your confidence (0-1), and baseline metric values if known. Use status \"recommended\" when proposing, \"applied\" when the action was actually taken.",
      inputSchema: {
        type: "object",
        properties: {
          interventionId: { type: "string" },
          target: {
            type: "object",
            properties: { id: { type: "string" }, type: { type: "string" } },
            required: ["id", "type"],
          },
          context: {
            type: "object",
            description: "Snapshot of conditions at selection time; used later for context-conditioned evidence",
          },
          baseline: {
            type: "object",
            description: "Pre-intervention metric values, e.g. {\"open_rate\": 0.21}",
            additionalProperties: { type: "number" },
          },
          reasonSelected: { type: "string" },
          confidence: { type: "number" },
          status: { type: "string", enum: RUN_STATUSES },
        },
        required: ["interventionId", "target"],
      },
      handler: (args) =>
        engine.recordRun({
          interventionId: args.interventionId as string,
          target: args.target as { id: string; type: string },
          context: args.context as Record<string, unknown> | undefined,
          baseline: args.baseline as Record<string, number> | undefined,
          reasonSelected: args.reasonSelected as string | undefined,
          confidence: args.confidence as number | undefined,
          status: args.status as RunStatus | undefined,
        }),
    },
    {
      name: "update_run_status",
      description:
        "Advance a run's lifecycle, e.g. a recommendation was accepted/rejected, or an accepted recommendation was applied. Only applied runs are ever evaluated — ignored recommendations never count against an intervention.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          status: { type: "string", enum: RUN_STATUSES },
        },
        required: ["runId", "status"],
      },
      handler: (args) =>
        engine.updateRunStatus(args.runId as string, args.status as RunStatus),
    },
    {
      name: "list_runs",
      description:
        "List intervention runs, filterable by intervention, target, or lifecycle status.",
      inputSchema: {
        type: "object",
        properties: {
          interventionId: { type: "string" },
          targetId: { type: "string" },
          targetType: { type: "string" },
          status: { type: "string", enum: RUN_STATUSES },
        },
      },
      handler: (args) =>
        engine.listRuns({
          interventionId: args.interventionId as string | undefined,
          targetId: args.targetId as string | undefined,
          targetType: args.targetType as string | undefined,
          status: args.status as RunStatus | undefined,
        }),
    },
    {
      name: "get_run",
      description:
        "Get one run with its full record: context snapshot, measurements (baseline and outcome), and evaluations.",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
      handler: async (args) => {
        const runId = args.runId as string;
        const [run, measurements, evaluations] = await Promise.all([
          engine.getRun(runId),
          engine.getMeasurements(runId),
          engine.getEvaluations(runId),
        ]);
        return { run, measurements, evaluations };
      },
    },
    {
      name: "record_measurement",
      description:
        "Record an observed metric value for a run — phase \"baseline\" for pre-intervention observations, \"outcome\" (default) for post-intervention. Multiple measurements per metric are fine; evaluation uses the latest per phase.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          metric: { type: "string" },
          value: { type: "number" },
          phase: { type: "string", enum: ["baseline", "outcome"] },
          measuredAt: { type: "string", description: "ISO timestamp; defaults to now" },
          source: { type: "string", description: "Where the value came from, e.g. \"ga4\", \"manual\"" },
        },
        required: ["runId", "metric", "value"],
      },
      handler: (args) =>
        engine.recordMeasurement({
          runId: args.runId as string,
          metric: args.metric as string,
          value: args.value as number,
          phase: args.phase as "baseline" | "outcome" | undefined,
          measuredAt: args.measuredAt as string | undefined,
          source: args.source as string | undefined,
        }),
    },
    {
      name: "evaluate_run",
      description:
        "Evaluate an applied run: compares latest baseline vs latest outcome per success metric, producing direction-aware deltas and an overall outcome. The result is observational evidence — what happened after the intervention, not proof the intervention caused it.",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
      handler: (args) => engine.evaluateRun(args.runId as string),
    },
    {
      name: "get_intervention_performance",
      description:
        "Aggregated historical evidence for an intervention: run counts by status, evaluated-run outcomes, positive rate, per-metric deltas. Filter by context to see performance in situations comparable to a current target (e.g. {\"campaignType\": \"webinar\"}), or group by context keys to see where it works and where it doesn't. Weigh evidence volume, not just rates — 100% positive over 1 run is weaker evidence than 75% over 40.",
      inputSchema: {
        type: "object",
        properties: {
          interventionId: { type: "string" },
          context: {
            type: "object",
            description: "Only count runs whose context matches these key/value pairs",
          },
          groupBy: {
            type: "array",
            items: { type: "string" },
            description: "Context keys to break performance down by",
          },
        },
        required: ["interventionId"],
      },
      handler: (args) =>
        engine.getInterventionPerformance(args.interventionId as string, {
          context: args.context as Record<string, unknown> | undefined,
          groupBy: args.groupBy as string[] | undefined,
        }),
    },
  ];
}
