import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { InterventionEngine, McpToolServer, buildMcpTools } from "../src/index.js";

function makeServer() {
  const engine = new InterventionEngine();
  return new McpToolServer(
    { name: "intervention-engine", version: "0.1.0" },
    buildMcpTools(engine)
  );
}

async function call(
  server: McpToolServer,
  name: string,
  args: Record<string, unknown>
) {
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = response!.result as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return { result, parsed: result.isError ? null : JSON.parse(result.content[0].text) };
}

describe("MCP server", () => {
  it("negotiates initialize and lists all engine tools", async () => {
    const server = makeServer();
    const init = await server.handleMessage({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: {} },
    });
    const initResult = init!.result as Record<string, any>;
    expect(initResult.protocolVersion).toBe("2025-03-26");
    expect(initResult.capabilities.tools).toEqual({});
    expect(initResult.serverInfo.name).toBe("intervention-engine");

    const list = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (list!.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "list_interventions",
      "define_intervention",
      "get_intervention",
      "record_run",
      "update_run_status",
      "list_runs",
      "get_run",
      "record_measurement",
      "evaluate_run",
      "get_intervention_performance",
    ]);
  });

  it("runs the full lifecycle through tools/call", async () => {
    const server = makeServer();
    const { parsed: definition } = await call(server, "define_intervention", {
      id: "change-subject",
      name: "Change subject line",
      targetTypes: ["email"],
      successMetrics: ["open_rate"],
    });
    expect(definition.version).toBe(1);

    const { parsed: run } = await call(server, "record_run", {
      interventionId: "change-subject",
      target: { id: "email-1", type: "email" },
      context: { campaignType: "webinar" },
      baseline: { open_rate: 0.2 },
      status: "applied",
    });
    expect(run.interventionVersion).toBe(1);

    await call(server, "record_measurement", {
      runId: run.id,
      metric: "open_rate",
      value: 0.26,
      source: "manual",
    });
    const { parsed: evaluation } = await call(server, "evaluate_run", { runId: run.id });
    expect(evaluation.outcome).toBe("positive");

    const { parsed: full } = await call(server, "get_run", { runId: run.id });
    expect(full.measurements).toHaveLength(2);
    expect(full.evaluations).toHaveLength(1);

    const { parsed: perf } = await call(server, "get_intervention_performance", {
      interventionId: "change-subject",
      context: { campaignType: "webinar" },
    });
    expect(perf.evaluatedRuns).toBe(1);
    expect(perf.positiveRate).toBe(1);
  });

  it("returns tool errors as isError content, not protocol errors", async () => {
    const server = makeServer();
    const { result } = await call(server, "record_run", {
      interventionId: "does-not-exist",
      target: { id: "x", type: "email" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown intervention");

    const { result: unknownTool } = await call(server, "no_such_tool", {});
    expect(unknownTool.isError).toBe(true);
  });

  it("handles ping, ignores notifications, rejects unknown methods", async () => {
    const server = makeServer();
    const ping = await server.handleMessage({ jsonrpc: "2.0", id: 5, method: "ping" });
    expect(ping!.result).toEqual({});

    const note = await server.handleMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(note).toBeNull();

    const bad = await server.handleMessage({
      jsonrpc: "2.0",
      id: 6,
      method: "resources/list",
    });
    expect(bad!.error!.code).toBe(-32601);
  });

  it("speaks newline-delimited JSON-RPC over streams", async () => {
    const server = makeServer();
    const input = new PassThrough();
    const output = new PassThrough();
    const done = server.serve(input, output);

    input.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n"
    );
    input.write("not json\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    input.end();
    await done;

    const responses = output
      .read()
      .toString()
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    expect(responses).toHaveLength(3);
    expect(responses[0].result.serverInfo.name).toBe("intervention-engine");
    expect(responses[1].error.code).toBe(-32700);
    expect(responses[2].result.tools.length).toBe(10);
  });
});
