import { randomUUID } from "node:crypto";
import type { McpServerInput, McpServerRecord } from "../contracts/acp.ts";
import { getDb } from "./db.ts";

export function listMcpServers(): McpServerRecord[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM mcp_servers ORDER BY name ASC")
    .all() as unknown as McpServerRecord[];
}

export function getMcpServer(id: string): McpServerRecord | null {
  const row = getDb().prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as
    | McpServerRecord
    | undefined;
  return row ?? null;
}

export function createMcpServer(input: McpServerInput): McpServerRecord {
  const now = Date.now();
  const row: McpServerRecord = {
    id: randomUUID(),
    name: input.name.trim(),
    transport_type: input.transport_type,
    url: input.url ?? null,
    command: input.command ?? null,
    args: input.args ? JSON.stringify(input.args) : null,
    env: input.env ? JSON.stringify(input.env) : null,
    created_at: now,
    updated_at: now,
  };
  getDb()
    .prepare(
      `INSERT INTO mcp_servers (id, name, transport_type, url, command, args, env, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.name,
      row.transport_type,
      row.url,
      row.command,
      row.args,
      row.env,
      row.created_at,
      row.updated_at,
    );
  return row;
}

export function updateMcpServer(
  id: string,
  input: Partial<McpServerInput>,
): McpServerRecord | null {
  const existing = getMcpServer(id);
  if (!existing) return null;
  const updated: McpServerRecord = {
    ...existing,
    name: input.name?.trim() ?? existing.name,
    transport_type: input.transport_type ?? existing.transport_type,
    url: input.url !== undefined ? (input.url ?? null) : existing.url,
    command: input.command !== undefined ? (input.command ?? null) : existing.command,
    args:
      input.args !== undefined ? (input.args ? JSON.stringify(input.args) : null) : existing.args,
    env: input.env !== undefined ? (input.env ? JSON.stringify(input.env) : null) : existing.env,
    updated_at: Date.now(),
  };
  getDb()
    .prepare(
      `UPDATE mcp_servers SET name = ?, transport_type = ?, url = ?, command = ?, args = ?, env = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      updated.name,
      updated.transport_type,
      updated.url,
      updated.command,
      updated.args,
      updated.env,
      updated.updated_at,
      id,
    );
  return updated;
}

export function deleteMcpServer(id: string): void {
  getDb().prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
}

/**
 * ACP entries for local (stdio) connectors, which every agent accepts (ACP
 * requires stdio MCP). Remote connectors aren't here: they reach sessions
 * through Pipper's connector gateway, which holds their sign-in.
 */
export function toAcpMcpServers<Row extends McpServerRecord & { enabled?: number }>(
  rows: Row[],
  envFor: (row: Row) => Record<string, string>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (row.enabled === 0) continue;
    if (row.transport_type === "stdio" && row.command) {
      let args: string[] = [];
      try {
        if (row.args) args = JSON.parse(row.args) as string[];
      } catch {
        args = [];
      }
      const env = envFor(row);
      out.push({
        type: "stdio",
        name: row.name,
        command: row.command,
        args,
        env: Object.entries(env).map(([name, value]) => ({ name, value })),
      });
    }
  }
  return out;
}
