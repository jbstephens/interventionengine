import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * Minimal MCP (Model Context Protocol) server over stdio: newline-delimited
 * JSON-RPC 2.0 exposing a set of tools. Hand-rolled deliberately — the
 * tools-only slice of MCP is a small, stable handshake (initialize ->
 * tools/list -> tools/call), and implementing it directly keeps the
 * library's zero-runtime-dependency property.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL_VERSION = "2025-06-18";

export class McpToolServer {
  private readonly tools: Map<string, McpToolDefinition>;

  constructor(
    private readonly serverInfo: { name: string; version: string },
    tools: McpToolDefinition[]
  ) {
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  /**
   * Handle one JSON-RPC message. Returns the response to send, or null for
   * notifications (which get no response).
   */
  async handleMessage(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const { id, method, params = {} } = message;
    const isNotification = id === undefined;

    try {
      switch (method) {
        case "initialize": {
          const requested = params.protocolVersion as string | undefined;
          return this.result(id!, {
            protocolVersion:
              requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
                ? requested
                : LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: this.serverInfo,
          });
        }
        case "ping":
          return this.result(id!, {});
        case "tools/list":
          return this.result(id!, {
            tools: [...this.tools.values()].map(
              ({ name, description, inputSchema }) => ({
                name,
                description,
                inputSchema,
              })
            ),
          });
        case "tools/call": {
          const name = params.name as string;
          const args = (params.arguments ?? {}) as Record<string, unknown>;
          const tool = this.tools.get(name);
          if (!tool) {
            return this.result(id!, toolError(`Unknown tool: ${name}`));
          }
          try {
            const value = await tool.handler(args);
            return this.result(id!, {
              content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
            });
          } catch (error) {
            return this.result(id!, toolError(String((error as Error).message ?? error)));
          }
        }
        default:
          if (isNotification) return null; // notifications/initialized etc.
          return {
            jsonrpc: "2.0",
            id: id ?? null,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }
    } catch (error) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32603, message: String((error as Error).message ?? error) },
      };
    }
  }

  /**
   * Run the newline-delimited JSON-RPC loop over the given streams.
   * Messages are processed strictly in order so responses never interleave.
   */
  serve(input: Readable, output: Writable): Promise<void> {
    let queue: Promise<void> = Promise.resolve();
    return new Promise((resolve) => {
      const lines = createInterface({ input });
      lines.on("line", (line) => {
        if (!line.trim()) return;
        queue = queue.then(async () => {
          let message: JsonRpcRequest;
          try {
            message = JSON.parse(line) as JsonRpcRequest;
          } catch {
            output.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32700, message: "Parse error" },
              }) + "\n"
            );
            return;
          }
          const response = await this.handleMessage(message);
          if (response) output.write(JSON.stringify(response) + "\n");
        });
      });
      lines.on("close", () => {
        void queue.then(resolve);
      });
    });
  }

  private result(id: number | string | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id: id ?? null, result };
  }
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}
