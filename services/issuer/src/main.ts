/** Runs the issuer as an HTTP service. Configuration comes from the environment. */
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { signerFromPrivateJwk } from "@ojcp/credentials-core";
import { z } from "zod";
import { createApp } from "./app.tsx";
import {
  type AgentClient,
  ConsoleMessenger,
  DirectoryMandateKeySource,
  type Messenger,
} from "./config.ts";
import { Issuer } from "./issuer.ts";
import { SqliteIssuerStore } from "./sqlite-store.ts";

const Env = z.object({
  OJCP_ISSUER_URL: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/$/, "")),
  PORT: z.coerce.number().int().default(8080),
  OJCP_SIGNING_KEY: z.string().transform((s) => JSON.parse(s) as unknown),
  OJCP_SIGN_UNTIL: z.coerce.number().int(),
  OJCP_CLIENTS_FILE: z.string(),
  OJCP_STATUS_LISTS: z.coerce.number().int().min(2).default(4),
  OJCP_DATABASE: z.string().default("issuer.db"),
  OJCP_POLICY_URI: z.url(),
  OJCP_CONSUMER_REPORTING_AGENCY: z.enum(["true", "false"]).optional(),
  OJCP_ADMIN_TOKEN: z.string().min(32).optional(),
  OJCP_COOKIE_SECRET: z.string().min(32),
  OJCP_MESSENGER_WEBHOOK: z.url().optional(),
  OJCP_OJCP_VERSION: z.string().default("0.3"),
  OJCP_DISPLAY_NAME: z.string().min(1).optional(),
  OJCP_CONSENT_UI: z
    .string()
    .regex(/^(\/|https:\/\/).*\{id\}/)
    .optional(),
  NODE_ENV: z.string().optional(),
});

const AgentClients = z.array(
  z.strictObject({
    clientId: z.string(),
    name: z.string(),
    agentId: z.string(),
    redirectUris: z.array(z.url()),
    keyDirectory: z.url(),
    affiliated: z.boolean(),
  }),
);

/** Posts each message as JSON to a delivery service (email/SMS gateway). */
class WebhookMessenger implements Messenger {
  readonly #url: string;
  constructor(url: string) {
    this.#url = url;
  }
  async send(
    to: { email: string } | { phone: string },
    message: { subject: string; text: string },
  ): Promise<void> {
    const response = await fetch(this.#url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, ...message }),
    });
    if (!response.ok) throw new Error(`message delivery failed: ${response.status}`);
  }
}

const env = Env.parse(process.env);
const signer = await signerFromPrivateJwk(
  z.record(z.string(), z.unknown()).parse(env.OJCP_SIGNING_KEY),
);
if (signer.alg !== "ES256") throw new Error("the signing key must be P-256 (ES256)");
const clients: AgentClient[] = AgentClients.parse(
  JSON.parse(readFileSync(env.OJCP_CLIENTS_FILE, "utf8")),
);
let messenger: Messenger;
if (env.OJCP_MESSENGER_WEBHOOK) messenger = new WebhookMessenger(env.OJCP_MESSENGER_WEBHOOK);
else if (env.NODE_ENV !== "production") messenger = new ConsoleMessenger();
else throw new Error("OJCP_MESSENGER_WEBHOOK is required in production");

const store = new SqliteIssuerStore(env.OJCP_DATABASE);
const mandateKeys = new DirectoryMandateKeySource(store);
const issuer = await Issuer.create({
  issuer: env.OJCP_ISSUER_URL,
  signer,
  signUntil: env.OJCP_SIGN_UNTIL,
  store,
  messenger,
  mandateKeys,
  clients,
  statusLists: Array.from(
    { length: env.OJCP_STATUS_LISTS },
    (_, i) => `${env.OJCP_ISSUER_URL}/status/${i + 1}`,
  ),
  ojcpVersion: env.OJCP_OJCP_VERSION,
  policyUri: env.OJCP_POLICY_URI,
  ...(env.OJCP_CONSUMER_REPORTING_AGENCY
    ? { consumerReportingAgency: env.OJCP_CONSUMER_REPORTING_AGENCY === "true" }
    : {}),
  ...(env.OJCP_ADMIN_TOKEN ? { adminToken: env.OJCP_ADMIN_TOKEN } : {}),
  cookieSecret: env.OJCP_COOKIE_SECRET,
  ...(env.OJCP_DISPLAY_NAME ? { displayName: env.OJCP_DISPLAY_NAME } : {}),
  ...(env.OJCP_CONSENT_UI ? { consentUi: env.OJCP_CONSENT_UI } : {}),
});

// Status changes apply at fixed hourly epochs (RFC 0008 §7.1).
const HOUR = 3_600_000;
setInterval(
  () => void issuer.status.applyEpoch().catch((e) => console.error("status epoch failed", e)),
  HOUR,
).unref();
// Poll agent key directories so first-seen times exist before the 7-day rule needs them (RFC 0008 §3.4).
const pollDirectories = () =>
  Promise.allSettled(clients.map((client) => mandateKeys.mandateKeys(client))).then((results) => {
    for (const r of results)
      if (r.status === "rejected") console.error("key directory poll failed", r.reason);
  });
void pollDirectories();
setInterval(() => void pollDirectories(), HOUR).unref();

serve({ fetch: createApp(issuer).fetch, port: env.PORT }, (info) =>
  console.info(`OJCP issuer ${env.OJCP_ISSUER_URL} listening on :${info.port}`),
);
