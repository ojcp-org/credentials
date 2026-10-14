/**
 * LLM mode: a model drives the demo agent through a few high-level tools.
 * The model never handles credentials; the wallet attaches mandates and
 * signatures under its own rules, so a model can't talk its way past them.
 */
import { isRecord } from "@ojcp/credentials-core";
import { z } from "zod";
import type { Host } from "../config.ts";
import { CANDIDATE } from "../world.ts";
import { PROVIDER_HOSTS, type SandboxAgent } from "./agent.ts";
import type { CandidateView } from "./candidate.ts";

const API = "https://api.anthropic.com/v1";
const VERSION = "2023-06-01";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };
interface Message {
  role: "user" | "assistant";
  content: string | Block[];
}

const MessageResponse = z.looseObject({
  stop_reason: z.string().nullable(),
  content: z.array(
    z.looseObject({
      type: z.string(),
      text: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      input: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

const provider = { type: "string", enum: PROVIDER_HOSTS, description: "Which sandbox provider" };
const isProviderHost = (value: unknown): value is Host => PROVIDER_HOSTS.some((h) => h === value);
const TOOLS = [
  {
    name: "list_providers",
    description: "The OJCP providers the agent can reach.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "check_trust",
    description:
      "Derive a provider's trust tier from the agent's pinned trust list (RFC 0010) and the sentence to show the candidate.",
    input_schema: { type: "object", properties: { provider }, required: ["provider"] },
  },
  {
    name: "search_jobs",
    description: "Search a provider's jobs.",
    input_schema: { type: "object", properties: { provider }, required: ["provider"] },
  },
  {
    name: "apply",
    description:
      "Apply to a job under the candidate's standing mandate. The wallet refuses anything the mandate doesn't cover and stops at legal agreements, which only the candidate can approve.",
    input_schema: {
      type: "object",
      properties: { provider, job_id: { type: "string" } },
      required: ["provider", "job_id"],
    },
  },
  {
    name: "mandate_status",
    description: "The candidate's standing mandate, applications so far and approvals waiting.",
    input_schema: { type: "object", properties: {} },
  },
];

const SYSTEM = `You are JobGPT, ${CANDIDATE.name}'s AI assistant (${CANDIDATE.email}), using your Job search app in the OJCP sandbox, a test world with made-up employers.
You act under a standing mandate the candidate approved in their wallet, whose provider runs the permission service. Apply only through the tools; the mandate is enforced by the agent wallet library and by employers, and you cannot override it.
Before applying anywhere, check the provider's trust and tell the candidate who will receive the application, using the sentence check_trust returns, never a site's own name.
When the wallet library or a provider refuses, explain the reason plainly. Never agree to terms for the candidate, and never handle their work records: employers ask for those through the candidate's wallet on their own page. If an application needs the candidate, tell them so.
Be brief.`;

export class LlmSession {
  readonly #agent: SandboxAgent;
  readonly #view: CandidateView;
  readonly #apiKey: string;
  #model: string | undefined;
  readonly messages: Message[] = [];

  constructor(agent: SandboxAgent, view: CandidateView, apiKey: string, model?: string) {
    this.#agent = agent;
    this.#view = view;
    this.#apiKey = apiKey;
    this.#model = model;
  }

  async #headers(): Promise<Record<string, string>> {
    return {
      "x-api-key": this.#apiKey,
      "anthropic-version": VERSION,
      "content-type": "application/json",
    };
  }

  /** The configured model, or the newest the key can use. */
  async model(): Promise<string> {
    if (this.#model) return this.#model;
    const response = await fetch(`${API}/models?limit=20`, { headers: await this.#headers() });
    const list = z
      .object({ data: z.array(z.object({ id: z.string(), created_at: z.string() })) })
      .parse(await response.json());
    const newest = [...list.data].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!newest) throw new Error("no models available to this API key");
    this.#model = newest.id;
    return newest.id;
  }

  async #tool(name: string, input: Record<string, unknown>): Promise<unknown> {
    const host = isProviderHost(input.provider) ? input.provider : undefined;
    const origins = this.#agent.world.origins;
    switch (name) {
      case "list_providers":
        return PROVIDER_HOSTS.map((h) => ({
          provider: h,
          origin: origins.origin(h),
          name: this.#agent.world.providers.get(h)?.name,
        }));
      case "check_trust":
        if (!host) return { error: "unknown provider" };
        return this.#agent.describe(host);
      case "search_jobs":
        if (!host) return { error: "unknown provider" };
        return (await this.#agent.search(host)).map((j) => ({
          job_id: j.ojcp_id,
          title: j.title,
          employer: j.employer?.ojcp_employer_id,
          remote_policy: j.remote_policy,
          pay: j.baseSalary,
          occupation: j.occupationalCategory?.[0],
        }));
      case "apply": {
        if (!host || typeof input.job_id !== "string")
          return { error: "provider and job_id are required" };
        const record = await this.#view.apply(host, input.job_id);
        return { result: record.headline, explanation: record.detail, goes_to: record.recipient };
      }
      case "mandate_status":
        return this.#agent.state();
      default:
        return { error: `unknown tool ${name}` };
    }
  }

  /** One user turn: runs the model and its tool calls until it answers. */
  async send(text: string): Promise<string> {
    this.messages.push({ role: "user", content: text });
    const model = await this.model();
    for (let turn = 0; turn < 10; turn++) {
      const response = await fetch(`${API}/messages`, {
        method: "POST",
        headers: await this.#headers(),
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: SYSTEM,
          tools: TOOLS,
          messages: this.messages,
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          `model call failed (${response.status}): ${JSON.stringify(isRecord(body) ? body.error : body)}`,
        );
      const parsed = MessageResponse.parse(body);
      const blocks: Block[] = parsed.content.flatMap((b): Block[] =>
        b.type === "text" && b.text !== undefined
          ? [{ type: "text", text: b.text }]
          : b.type === "tool_use" && b.id && b.name
            ? [{ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} }]
            : [],
      );
      this.messages.push({ role: "assistant", content: blocks });
      const calls = blocks.filter(
        (b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use",
      );
      if (parsed.stop_reason !== "tool_use" || calls.length === 0)
        return blocks
          .flatMap((b) => (b.type === "text" ? [b.text] : []))
          .join("\n")
          .trim();
      const results: Block[] = [];
      for (const call of calls) {
        let result: unknown;
        try {
          result = await this.#tool(call.name, call.input);
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(result),
        });
      }
      this.messages.push({ role: "user", content: results });
    }
    return "Stopped after 10 tool rounds.";
  }
}
