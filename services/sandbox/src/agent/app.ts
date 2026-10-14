/** The assistant's origin: key directory, OAuth callback, and the calls behind its chat. */
import { Hono } from "hono";
import { z } from "zod";
import type { SandboxWorld } from "../world.ts";
import type { SandboxAgent } from "./agent.ts";
import type { Assistant } from "./assistant.ts";
import type { CandidateView } from "./candidate.ts";

export function agentApp(
  world: SandboxWorld,
  agent: SandboxAgent,
  view: CandidateView,
  assistant: Assistant,
): Hono {
  const app = new Hono();
  const origins = world.origins;

  app.onError((error, c) =>
    c.json({ error: error instanceof Error ? error.message : String(error) }, 400),
  );

  app.get("/.well-known/http-message-signatures-directory", () =>
    world.keyring.directoryResponse(),
  );

  app.get("/callback", async (c) => {
    if (c.req.query("error")) {
      world.events.emit({
        actor: "candidate",
        where: origins.host("issuer"),
        title: "Candidate declined on the consent page",
        outcome: "refused",
      });
      return c.redirect("/", 303);
    }
    world.events.emit({
      actor: "candidate",
      where: origins.host("issuer"),
      title: "Candidate approved on the issuer's consent page",
      outcome: "ok",
    });
    await agent.completeMandate(c.req.query("code") ?? "", c.req.query("state") ?? "");
    await assistant.onPermission();
    return c.redirect("/", 303);
  });

  app.get("/api/chat", async (c) => {
    // Notice a permission cancelled in the wallet, the way employers will.
    if (await agent.syncStatus()) assistant.onCancelled();
    return c.json({
      messages: assistant.messages,
      suggestions: await assistant.suggestions(),
      usesModel: assistant.usesModel,
      proposal: view.proposalSummary(),
      permission: (await view.summary()) ?? null,
      cancelled: (await agent.store.batches()).some((b) => b.revoked),
      applications: view.applications,
      issuer: origins.origin("issuer"),
    });
  });
  app.get("/api/feed", async (c) => c.json(await view.feed()));

  app.post("/api/chat", async (c) => {
    const { text } = z
      .object({ text: z.string().trim().min(1).max(2000) })
      .parse(await c.req.json());
    await assistant.send(text);
    return c.json({ ok: true });
  });
  app.post("/api/mandate/start", async (c) => c.json({ url: await agent.startMandate() }));
  app.post("/api/mandate/auto", async (c) => {
    await agent.approveAsCandidate();
    await assistant.onPermission();
    return c.json({ ok: true });
  });
  app.post("/api/apply-all", async (c) => {
    await assistant.applyAll();
    return c.json({ ok: true });
  });
  const Record = z.object({ record: z.string() });
  app.post("/api/approve", async (c) => {
    await assistant.approveTerms(Record.parse(await c.req.json()).record);
    return c.json({ ok: true });
  });
  app.post("/api/verification/continue", async (c) => {
    await assistant.continueVerification(Record.parse(await c.req.json()).record);
    return c.json({ ok: true });
  });
  return app;
}
