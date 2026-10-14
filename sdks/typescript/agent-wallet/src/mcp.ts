/**
 * Connects an MCP client to an OJCP provider with every HTTP request signed.
 * Requires the optional peer dependency `@modelcontextprotocol/sdk`.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createSignedFetch, type SignedFetchOptions } from "./signed-fetch.ts";

export interface ConnectOptions extends SignedFetchOptions {
  /** The provider's MCP endpoint, from its Job Manifest. */
  url: string;
  clientInfo?: { name: string; version: string };
}

export async function connectOjcpProvider(options: ConnectOptions): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    fetch: createSignedFetch(options),
  });
  const client = new Client(options.clientInfo ?? { name: "ojcp-agent", version: "0.0.0" });
  await client.connect(transport);
  return client;
}
