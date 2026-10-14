/**
 * Runs the whole sandbox in one process, one Hono app per origin, routed by
 * Host. Origins still reach each other over real HTTPS through DNS. Locally
 * the process serves TLS itself; deployed, a load balancer terminates TLS.
 *
 * Every party's pages are one React app (`ui/`), served on each origin with a
 * bootstrap naming the persona; each party's own app answers everything else.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { PROVIDER_HOSTS, SandboxAgent } from "./agent/agent.ts";
import { agentApp } from "./agent/app.ts";
import { Assistant } from "./agent/assistant.ts";
import { CandidateView } from "./agent/candidate.ts";
import { LlmSession } from "./agent/llm.ts";
import { HOSTS, type Host, NOTICE, type SandboxConfig } from "./config.ts";
import { type Sandbox, sandboxApi } from "./sandbox-api.ts";
import { uiAsset, uiPage } from "./ui-assets.ts";
import { CANDIDATE, SandboxWorld } from "./world.ts";

const Env = z.object({
  SANDBOX_DOMAIN: z.string().default("sandbox.lvh.me"),
  PORT: z.coerce.number().int().default(8080),
  SANDBOX_PUBLIC_PORT: z.coerce.number().int().optional(),
  SANDBOX_TLS_KEY: z.string().optional(),
  SANDBOX_TLS_CERT: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  SANDBOX_LLM_MODEL: z.string().optional(),
});
const env = Env.parse(process.env);

const config: SandboxConfig = {
  domain: env.SANDBOX_DOMAIN,
  listenPort: env.PORT,
  ...(env.SANDBOX_PUBLIC_PORT ? { publicPort: env.SANDBOX_PUBLIC_PORT } : {}),
  ...(env.SANDBOX_TLS_KEY && env.SANDBOX_TLS_CERT
    ? {
        tls: {
          key: readFileSync(env.SANDBOX_TLS_KEY, "utf8"),
          cert: readFileSync(env.SANDBOX_TLS_CERT, "utf8"),
        },
      }
    : {}),
  ...(env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}),
  ...(env.SANDBOX_LLM_MODEL ? { llmModel: env.SANDBOX_LLM_MODEL } : {}),
};

let running: Sandbox;

async function build(): Promise<Sandbox> {
  const world = await SandboxWorld.create(config);
  const agent = await SandboxAgent.create(world);
  const view = new CandidateView(agent);
  const llm = config.anthropicApiKey
    ? new LlmSession(agent, view, config.anthropicApiKey, config.llmModel)
    : undefined;
  const assistant = new Assistant(agent, view, llm);
  world.apps.set("agent", agentApp(world, agent, view, assistant));
  return { world, agent, view, assistant, visited: new Set() };
}

/** The React app's pages on each origin; everything else is the party's own. */
const PAGES: Partial<Record<Host, RegExp>> = {
  // The welcome, and the technical view.
  home: /^\/(hood)?$/,
  agent: /^\/$/,
  hr: /^\/(practice)?$/,
  // The permission service's consent screen is a screen in the wallet app.
  wallet: /^\/(offer|authorize|permissions\/[A-Za-z0-9_-]+)?$/,
  acme: /^\/(verify\/[A-Z0-9]{4,6}|ats)?$/,
  lookalike: /^\/$/,
  ats: /^\/$/,
  globex: /^\/$/,
  attestA: /^\/$/,
  attestB: /^\/$/,
  lists: /^\/$/,
};

running = await build();
const sandbox = sandboxApi(
  () => running,
  async () => {
    running = await build();
  },
);

const fetchHandler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  // Kubelet probes arrive with the pod's IP as Host, so this answers on any host.
  if (url.pathname === "/healthz") return new Response("ok");
  const { world } = running;
  const role = world.origins.resolve(request.headers.get("host") ?? url.host);
  if (!role)
    return new Response(`Unknown sandbox host. Try ${world.origins.origin("home")}/`, {
      status: 404,
    });
  if (url.pathname.startsWith("/_ui/")) return uiAsset(url.pathname);
  // The pages' own calls come from the sandbox's sites. A browser sending a
  // state change from anywhere else is another site acting on a visitor's
  // behalf, so refuse it. Protocol endpoints (MCP, /token, direct_post) are
  // called by servers and carry no Sec-Fetch-Site.
  if (
    request.method !== "GET" &&
    (url.pathname.startsWith("/_sandbox/") || url.pathname.startsWith("/api/")) &&
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return new Response("Cross-site requests aren't accepted.", { status: 403 });
  if (url.pathname.startsWith("/_sandbox/"))
    return sandbox.fetch(new Request(new URL(url.pathname.slice(9) + url.search, url), request));
  if (request.method === "GET" && PAGES[role]?.test(url.pathname))
    return uiPage({
      role,
      origins: Object.fromEntries(world.origins.all().map((o) => [o.name, o.origin])),
      notice: NOTICE,
      candidate: { name: CANDIDATE.name, email: CANDIDATE.email },
    });
  const app = world.apps.get(role);
  return app ? app.fetch(request) : new Response("Not found", { status: 404 });
};

// Status changes apply at hourly epochs in real time too (RFC 0008 §7.1), and
// providers refresh the status lists of the issuers they accept (RFC 0013 §6.2).
setInterval(() => void running.world.tick(), 3_600_000).unref();

serve(
  {
    fetch: fetchHandler,
    port: config.listenPort,
    ...(config.tls
      ? { createServer, serverOptions: { key: config.tls.key, cert: config.tls.cert } }
      : {}),
  },
  (info) => {
    console.info(`OJCP sandbox on :${info.port}`);
    for (const h of [...PROVIDER_HOSTS, "issuer", "hr", "wallet"] as const)
      console.info(`  ${running.world.origins.origin(h)}`);
    console.info(`  start at ${running.world.origins.origin("home")}/`);
    console.info(`  (${Object.keys(HOSTS).length} origins)`);
  },
);
