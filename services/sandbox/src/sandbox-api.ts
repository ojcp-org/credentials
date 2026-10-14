/**
 * What every origin serves under `/_sandbox/`: the story the persona bar shows,
 * the candidate's inbox, the timeline, and the lab. This is sandbox chrome, not
 * part of any party: it lets the bar on each site show the same story without
 * any site calling another.
 */
import { base64url, randomBytes } from "@ojcp/credentials-core";
import { Hono } from "hono";
import { z } from "zod";
import { PROVIDER_HOSTS, SandboxAgent } from "./agent/agent.ts";
import type { Assistant } from "./agent/assistant.ts";
import type { CandidateView } from "./agent/candidate.ts";
import { Probe } from "./agent/probe.ts";
import type { Host } from "./config.ts";
import type { SandboxWorld } from "./world.ts";

export interface Sandbox {
  world: SandboxWorld;
  agent: SandboxAgent;
  view: CandidateView;
  assistant: Assistant;
  /** Pages the story counts as seen. */
  visited: Set<"ats" | "hood">;
}

export type Tab = "hr" | "wallet" | "assistant" | "employer" | "hood";

/** A page, by origin and path; `prefix` matches every path under it. */
export interface StoryPage {
  url: string;
  prefix?: true;
}

export interface StoryStep {
  n: number;
  tab: Tab;
  title: string;
  /** What happens, in a sentence. */
  detail: string;
  /** Where to go next for this step. */
  href: string;
  /** The pages where the step can be done: the bar says "You're here" only on these. */
  at: StoryPage[];
  done: boolean;
}

async function story(s: Sandbox): Promise<StoryStep[]> {
  const { world, agent, view, assistant, visited } = s;
  const o = world.origins;
  const hasPermission = (await agent.store.batches()).length > 0;
  const acme = world.acmeWalletSteps.progress();
  const verifyUrl = view.applications.find((a) => a.verification)?.verification?.url;
  const acmeSentWithHistory = (world.providers.get("acme")?.received ?? []).some(
    (r) => r.workHistory !== undefined,
  );
  const shared = world.wallet.activity.some((a) => a.kind === "shared");
  const steps: Array<Omit<StoryStep, "n">> = [
    {
      tab: "hr",
      title: "Get your work record",
      detail:
        "Jordan works at Vandelay Industries. Its HR platform, ExamplePeople, can put a signed record of the job in his wallet at any time.",
      href: `${o.origin("hr")}/`,
      at: [{ url: `${o.origin("hr")}/` }],
      done: world.hr.offered || world.wallet.records.length > 0,
    },
    {
      tab: "wallet",
      title: "Save it in your wallet",
      detail:
        "The wallet checks the HR platform's signature and keeps three copies, each bound to its own key.",
      // The wallet opens from the HR portal's offer link, so that's where to go.
      href: `${o.origin("hr")}/`,
      at: [{ url: `${o.origin("wallet")}/offer` }],
      done: world.wallet.records.length > 0,
    },
    {
      tab: "assistant",
      title: "Ask JobGPT, your assistant, to find jobs",
      detail:
        "JobGPT is a ChatGPT-style assistant. Its Job search app finds roles on OJCP career sites and can apply for Jordan.",
      href: `${o.origin("agent")}/`,
      at: [{ url: `${o.origin("agent")}/` }],
      done: assistant.asked,
    },
    {
      tab: "wallet",
      title: "Approve JobGPT's permission in your wallet",
      detail:
        "Jordan's wallet provider runs the permission service. He chooses which jobs, where, minimum pay and how many applications, and can cancel there at any time; JobGPT can't change it.",
      href: agent.consentUrl ?? `${o.origin("agent")}/`,
      // Until JobGPT proposes, the step starts with its "Approve in my wallet" button.
      at: agent.consentUrl
        ? [{ url: `${o.origin("wallet")}/permissions/`, prefix: true }]
        : [{ url: `${o.origin("agent")}/` }],
      done: hasPermission,
    },
    {
      tab: "assistant",
      title: "Let it apply",
      detail:
        "It applies only where the permission covers the job and it can verify who runs the site.",
      href: `${o.origin("agent")}/`,
      at: [{ url: `${o.origin("agent")}/` }],
      done: view.applications.length > 0,
    },
    {
      tab: "employer",
      title: "Acme asks to confirm your work history",
      detail:
        "On its own page, Acme confirms Jordan's email first, so the check can't be attached to someone else's application.",
      href: verifyUrl ?? `${o.origin("acme")}/`,
      at: [{ url: `${o.origin("acme")}/verify/`, prefix: true }],
      done: acme.bound || acme.settled,
    },
    {
      tab: "wallet",
      title: "Approve sharing in your wallet",
      detail:
        "The wallet checks who's asking and shows exactly what Acme will see. Nothing goes through the assistant.",
      // The wallet opens from Acme's verification page.
      href: verifyUrl ?? `${o.origin("acme")}/`,
      at: [{ url: `${o.origin("wallet")}/authorize` }],
      done: shared || acme.settled,
    },
    {
      tab: "assistant",
      title: "Your assistant sends the application",
      detail: "Acme tells the assistant only that the step is done, never what the record said.",
      href: `${o.origin("agent")}/`,
      at: [{ url: `${o.origin("agent")}/` }],
      done: acmeSentWithHistory,
    },
    {
      tab: "employer",
      title: "See it from Acme's side",
      detail: "What Acme's recruiters receive, what was verified, and what they never learn.",
      href: `${o.origin("acme")}/ats`,
      at: [{ url: `${o.origin("acme")}/ats` }],
      done: visited.has("ats"),
    },
    {
      tab: "hood",
      title: "Under the hood",
      detail:
        "Every message between the parties, the trust network, and what happens when things go wrong.",
      href: `${o.origin("home")}/`,
      at: [{ url: `${o.origin("home")}/` }],
      done: visited.has("hood"),
    },
  ];
  return steps.map((step, i) => ({ ...step, n: i + 1 }));
}

const ProviderHost = z.enum(PROVIDER_HOSTS as [Host, ...Host[]]);
const CaseId = z.enum(Probe.CASES.map((c) => c.id) as [string, ...string[]]);
type CaseIdT = (typeof Probe.CASES)[number]["id"];

const ROLES: Partial<Record<Host, { name: string; role: string }>> = {
  hr: {
    name: "ExamplePeople (HR for Vandelay Industries)",
    role: "Issues employment records (RFC 0014)",
  },
  wallet: { name: "Jordan's wallet", role: "Holds records; presents them to employers (RFC 0013)" },
  agent: {
    name: "JobGPT, Jordan's AI assistant",
    role: "Agent platform with a Job search app (RFC 0008)",
  },
  issuer: {
    name: "Permission service (run by Jordan's wallet provider)",
    role: "Issues JobGPT's standing mandate; Jordan approves and cancels it in his wallet (RFC 0008)",
  },
  acme: { name: "Acme Corporation careers", role: "Employer running its own provider" },
  ats: { name: "ExampleATS", role: "ATS hosting Globex and Initech on one origin" },
  globex: { name: "Globex careers", role: "Tenant site of ExampleATS" },
  lookalike: {
    name: "acme-careers (lookalike)",
    role: "Uses Acme's name; no attestations of its own",
  },
  attestA: { name: "Sandbox KYB Co.", role: "Attester (RFC 0010)" },
  attestB: { name: "Sandbox Business Registry", role: "Attester (RFC 0010)" },
  lists: { name: "Sandbox trust list", role: "Trust-list publisher the assistant pins" },
};

export function sandboxApi(current: () => Sandbox, reset: () => Promise<void>): Hono {
  const app = new Hono();
  app.onError((error, c) =>
    c.json({ error: error instanceof Error ? error.message : String(error) }, 400),
  );

  app.get("/story", async (c) => {
    const s = current();
    const steps = await story(s);
    return c.json({
      steps,
      current: steps.find((x) => !x.done)?.n ?? steps.length,
      inbox: s.world.inbox.messages,
    });
  });
  app.post("/visit", async (c) => {
    const { page } = z.object({ page: z.enum(["ats", "hood"]) }).parse(await c.req.json());
    current().visited.add(page);
    return c.json({ ok: true });
  });
  app.get("/events", (c) => {
    const { events } = current().world;
    return c.json({ world: events.world, events: events.since(Number(c.req.query("since") ?? 0)) });
  });
  app.get("/parties", async (c) => {
    const { world, agent } = current();
    const parties = await Promise.all(
      (Object.keys(ROLES) as Host[]).map(async (host) => {
        const tier = PROVIDER_HOSTS.includes(host)
          ? (await agent.effectiveTier(world.origins.origin(host))).tier
          : undefined;
        return {
          host,
          origin: world.origins.origin(host),
          ...ROLES[host],
          ...(tier ? { tier } : {}),
        };
      }),
    );
    return c.json({
      parties,
      clock: { now: world.clock.now(), offset: world.clock.offset },
      probes: Probe.CASES.filter((p) => p.id !== "covered").map((p) => ({
        id: p.id,
        title: p.title,
        rfc: p.rfc,
        expected: p.expected,
      })),
    });
  });

  // ── Lab ──────────────────────────────────────────────────────────────────
  app.post("/lab/probe", async (c) => {
    const { world, agent } = current();
    const body = z.object({ provider: ProviderHost, case: CaseId }).parse(await c.req.json());
    const result = await (await Probe.at(agent, world.origins.origin(body.provider))).run(
      body.case as CaseIdT,
    );
    world.events.emit({
      actor: "agent",
      where: world.origins.host("agent"),
      title: `Hostile agent: ${result.title} → ${result.got}${result.pass === true ? ", as required" : result.pass === "skipped" ? " (skipped)" : ", NOT as required"}`,
      outcome: result.pass === false ? "refused" : "info",
      detail: { ...result },
    });
    return c.json(result);
  });

  app.post("/lab/incident/:kind", async (c) => {
    const { world, agent } = current();
    const kind = c.req.param("kind");
    const acme = world.providers.get("acme");
    const ats = world.providers.get("ats");
    if (kind === "takeover" && acme) await acme.takeOver();
    else if (kind === "suspend" && ats) world.attestB.suspend(ats.subject);
    else if (kind === "distrust") world.lists.distrust(world.attestA, "a test incident");
    else if (kind === "clear" && ats) {
      world.attestB.reinstate(ats.subject);
      world.lists.clearDistrust();
      world.events.emit({
        actor: "sandbox",
        where: world.origins.domain,
        title: "Incidents cleared (a domain takeover is undone only by resetting the sandbox)",
        outcome: "info",
      });
    } else if (kind === "cancel") await agent.revokeAsCandidate();
    else return c.json({ error: `unknown incident ${kind}` }, 404);
    agent.trust.invalidate();
    return c.json({ ok: true });
  });

  app.post("/lab/clock", async (c) => {
    const { seconds } = z
      .object({
        seconds: z
          .number()
          .int()
          .positive()
          .max(400 * 86_400),
      })
      .parse(await c.req.json());
    await current().world.advance(seconds);
    return c.json({ ok: true });
  });

  app.post("/lab/conformance", async (c) => {
    const { world } = current();
    // Only the sandbox's own providers: on a public deployment, a URL of the
    // visitor's choosing would make the server fetch anything it can reach.
    const { provider: host } = z.object({ provider: ProviderHost }).parse(await c.req.json());
    const provider = world.origins.origin(host);
    // A fresh candidate each run, so per-employer counts from earlier runs don't interfere.
    const runner = await SandboxAgent.create(
      world,
      `conformance+${base64url(randomBytes(6)).toLowerCase()}@example.com`,
    );
    await runner.approveAsCandidate();
    const results = await (await Probe.at(runner, provider)).runAll();
    const passed = results.filter((r) => r.pass === true).length;
    const failed = results.filter((r) => r.pass === false).length;
    world.events.emit({
      actor: "agent",
      where: world.origins.host("agent"),
      title: `Conformance against ${new URL(provider).host}: ${passed} passed, ${failed} failed, ${results.length - passed - failed} skipped`,
      outcome: failed ? "refused" : "ok",
      detail: { results },
    });
    return c.json({ results });
  });

  app.post("/lab/retry", async (c) => c.json(await current().agent.retryLast()));
  app.post("/lab/refresh", async (c) => {
    await current().agent.refresh();
    return c.json({ ok: true });
  });
  app.post("/lab/reset", async (c) => {
    await reset();
    return c.json({ ok: true });
  });
  return app;
}
