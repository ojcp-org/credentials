/**
 * The sandbox's origins. Every role has its own hostname, so origin-bound
 * checks (did:web, aud, Signature-Agent, status on the issuer's origin, the
 * ATS tenant rule) run exactly as they would between real parties.
 */
export const NOTICE =
  "OJCP sandbox. Test keys and made-up data only: nothing here is a real issuer, attester, trust list, employer or candidate, and nothing here should be trusted outside the sandbox.";

export interface SandboxConfig {
  /** e.g. `sandbox.ojcp.dev`, or `sandbox.lvh.me` locally. */
  domain: string;
  /** Public HTTPS port; omitted for 443. */
  publicPort?: number;
  /** Port the process listens on. */
  listenPort: number;
  /** Serve TLS directly (local) rather than behind a TLS-terminating load balancer. */
  tls?: { key: string; cert: string };
  anthropicApiKey?: string;
  llmModel?: string;
}

/** Hostname labels under the sandbox domain. */
export const HOSTS = {
  home: "",
  issuer: "issuer",
  agent: "agent",
  acme: "acme",
  lookalike: "acme-careers",
  ats: "ats",
  globex: "globex.ats",
  attestA: "attest-a",
  attestB: "attest-b",
  lists: "lists",
  // Where Jordan's work record can come from (sources.ts).
  hr: "hr",
  mdp: "mdp",
  vandelay: "vandelay",
  wallet: "wallet",
} as const;
export type Host = keyof typeof HOSTS;

export class Origins {
  readonly #config: SandboxConfig;
  constructor(config: SandboxConfig) {
    this.#config = config;
  }
  host(name: Host): string {
    const label = HOSTS[name];
    return label ? `${label}.${this.#config.domain}` : this.#config.domain;
  }
  origin(name: Host): string {
    const port =
      this.#config.publicPort && this.#config.publicPort !== 443
        ? `:${this.#config.publicPort}`
        : "";
    return `https://${this.host(name)}${port}`;
  }
  /** Which role a request's Host header addresses. */
  resolve(hostHeader: string | undefined): Host | undefined {
    const hostname = (hostHeader ?? "").split(":")[0]?.toLowerCase();
    return (Object.keys(HOSTS) as Host[]).find((h) => this.host(h) === hostname);
  }
  /** The agent_id the namespace rule gives the agent's origin. */
  get agentId(): string {
    return this.host("agent").split(".").reverse().join(".");
  }
  get domain(): string {
    return this.#config.domain;
  }
  all(): Array<{ name: Host; origin: string }> {
    return (Object.keys(HOSTS) as Host[]).map((name) => ({ name, origin: this.origin(name) }));
  }
}
