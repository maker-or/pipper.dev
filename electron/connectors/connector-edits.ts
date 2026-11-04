import { z } from "zod";
import { connectorCatalogEntry } from "../../contracts/connector-catalog.ts";
import type { ConnectorSnapshot } from "../../contracts/connectors.ts";
import type { ConnectorGateway } from "./connector-gateway.ts";
import type { ConnectorInput, ConnectorStore } from "./connector-store.ts";

/**
 * Adding, editing and removing connectors from Settings. Input comes from the
 * renderer, so it is checked here; values for keys, headers and `env` go
 * straight to the store, which seals them.
 */

const name = z.string().trim().min(1, "Give the connector a name.").max(80);
const values = z.record(z.string().trim().min(1).max(200), z.string().max(8_000));
export const REMOTE_URL = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      // Plain HTTP only to this computer: a token must not cross the network unencrypted.
      return (
        url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      );
    } catch {
      return false;
    }
  }, "Use an https:// URL (http:// only for localhost).");

const addInput = z.union([
  z.object({ catalogId: z.string(), key: z.string().trim().max(8_000).optional() }).strict(),
  z
    .object({
      name,
      transport: z.enum(["http", "sse"]),
      url: REMOTE_URL,
      headers: values.optional(),
    })
    .strict(),
  z
    .object({
      name,
      transport: z.literal("stdio"),
      command: z.string().trim().min(1, "Enter the command to run.").max(1_000),
      args: z.array(z.string().max(4_000)).max(100).optional(),
      env: values.optional(),
    })
    .strict(),
]);

const updateInput = z
  .object({
    name: name.optional(),
    url: REMOTE_URL.optional(),
    headers: values.optional(),
    command: z.string().trim().min(1).max(1_000).optional(),
    args: z.array(z.string().max(4_000)).max(100).optional(),
    env: values.optional(),
    key: z.string().trim().min(1).max(8_000).optional(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? "Invalid connector.");
  return result.data;
}

/** Empty values keep what Pipper has; names left out are dropped. */
function mergeValues(
  next: Record<string, string>,
  current: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(next).flatMap(([key, value]) => {
      const kept = value === "" ? current[key] : value;
      return kept === undefined ? [] : [[key, kept]];
    }),
  );
}

export function addConnector(
  store: ConnectorStore,
  gateway: ConnectorGateway,
  raw: unknown,
): ConnectorSnapshot {
  const input = parse(addInput, raw);
  let create: ConnectorInput;
  if ("catalogId" in input) {
    const entry = connectorCatalogEntry(input.catalogId);
    if (!entry) throw new Error("That connector isn't in Pipper's catalog.");
    if (store.list().some((row) => row.catalog_id === entry.id)) {
      throw new Error(`${entry.name} is already added.`);
    }
    if (entry.auth.kind === "key" && !input.key) throw new Error(`Paste your ${entry.auth.label}.`);
    create = {
      name: entry.name,
      transport_type: "http",
      url: entry.url,
      catalogId: entry.id,
      headers:
        entry.auth.kind === "key"
          ? { [entry.auth.header]: `${entry.auth.prefix ?? ""}${input.key}` }
          : null,
    };
  } else if (input.transport === "stdio") {
    create = {
      name: input.name,
      transport_type: "stdio",
      command: input.command,
      args: input.args ?? [],
      env: input.env && Object.keys(input.env).length > 0 ? input.env : null,
    };
  } else {
    create = {
      name: input.name,
      transport_type: input.transport,
      url: input.url,
      headers: input.headers && Object.keys(input.headers).length > 0 ? input.headers : null,
    };
  }
  return gateway.snapshotOf(store.create(create));
}

export function updateConnector(
  store: ConnectorStore,
  gateway: ConnectorGateway,
  id: string,
  raw: unknown,
): ConnectorSnapshot {
  const input = parse(updateInput, raw);
  const row = store.get(id);
  if (!row) throw new Error("That connector was removed.");
  const entry = connectorCatalogEntry(row.catalog_id);
  const change: Partial<ConnectorInput> = {};
  if (entry) {
    // A catalog connector's name and URL are Pipper's; only its key changes.
    if (input.key) {
      if (entry.auth.kind !== "key") throw new Error(`${entry.name} signs in in the browser.`);
      change.headers = { [entry.auth.header]: `${entry.auth.prefix ?? ""}${input.key}` };
    }
  } else if (row.transport_type === "stdio") {
    if (input.name !== undefined) change.name = input.name;
    if (input.command !== undefined) change.command = input.command;
    if (input.args !== undefined) change.args = input.args;
    if (input.env !== undefined) change.env = mergeValues(input.env, store.env(row));
  } else {
    if (input.name !== undefined) change.name = input.name;
    if (input.url !== undefined) change.url = input.url;
    if (input.headers !== undefined) {
      change.headers = mergeValues(input.headers, store.secrets(id).headers ?? {});
    }
  }
  // Drops the live connection, so the next session or check uses the change.
  gateway.forget(id);
  const updated = store.update(id, change);
  if (!updated) throw new Error("That connector was removed.");
  return gateway.snapshotOf(updated);
}

export function removeConnector(
  store: ConnectorStore,
  gateway: ConnectorGateway,
  id: string,
): void {
  gateway.forget(id);
  store.remove(id);
}
