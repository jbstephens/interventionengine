#!/usr/bin/env node
/**
 * Intervention Engine MCP server (stdio).
 *
 * Exposes the engine to any MCP client — Claude Code, Claude Desktop, or
 * agent frameworks — backed by a durable JSON store.
 *
 * Storage location (first match wins):
 *   INTERVENTION_ENGINE_DATA env var (path to a JSON file)
 *   ~/.intervention-engine/store.json
 *
 * Register with Claude Code:
 *   claude mcp add intervention-engine -- node /path/to/dist/mcp/server.js
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { InterventionEngine } from "../engine.js";
import { JsonFileRepository } from "../json-file-repository.js";
import { McpToolServer } from "./protocol.js";
import { buildTools } from "./tools.js";

const storePath =
  process.env.INTERVENTION_ENGINE_DATA ??
  join(homedir(), ".intervention-engine", "store.json");

const engine = new InterventionEngine({
  repository: new JsonFileRepository(storePath),
});

const server = new McpToolServer(
  { name: "intervention-engine", version: "0.1.0" },
  buildTools(engine)
);

// stdout carries only JSON-RPC; diagnostics go to stderr.
process.stderr.write(`intervention-engine MCP server; store: ${storePath}\n`);
await server.serve(process.stdin, process.stdout);
