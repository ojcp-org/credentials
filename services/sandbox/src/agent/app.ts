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
      // Only a decline for a request JobGPT actually made gets a reply.
      if (agent.declineMandate(c.req.query("state") ?? "")) assistant.onDeclined();
      return c.redirect("/", 303);
    }
    await assistant.serially(async () => {
      await agent.completeMandate(c.req.query("code") ?? "", c.req.query("state") ?? "");
      await assistant.onPermission();
    });
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

  // Everything that changes the candidate's state runs one request at a time.
  const serially = assistant.serially.bind(assistant);
  app.post("/api/chat", async (c) => {
    const { text } = z
      .object({ text: z.string().trim().min(1).max(2000) })
      .parse(await c.req.json());
    await serially(() => assistant.send(text));
    return c.json({ ok: true });
  });
  app.post("/api/mandate/start", async (c) =>
    c.json({ url: await serially(() => agent.startMandate()) }),
  );
  app.post("/api/mandate/auto", async (c) => {
    await serially(async () => {
      await agent.approveAsCandidate();
      await assistant.onPermission();
    });
    return c.json({ ok: true });
  });
  app.post("/api/apply-all", async (c) => {
    await serially(() => assistant.applyAll());
    return c.json({ ok: true });
  });
  const Record = z.object({ record: z.string() });
  app.post("/api/approve", async (c) => {
    const { record } = Record.parse(await c.req.json());
    await serially(() => assistant.approveTerms(record));
    return c.json({ ok: true });
  });
  app.post("/api/verification/continue", async (c) => {
    const { record } = Record.parse(await c.req.json());
    await serially(() => assistant.continueVerification(record));
    return c.json({ ok: true });
  });
  return app;
}
