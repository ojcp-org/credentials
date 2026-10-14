/**
 * The wallet's origin. Its screens are the React app; these are the calls
 * behind them. Offer links (`?credential_offer_uri=`) and OpenID4VP links
 * (`/authorize?client_id=&request_uri=`) land on this origin, the way a phone
 * hands a link to the wallet app.
 *
 * The wallet provider also runs the permission service that issues agents'
 * standing mandates, so the wallet lists and cancels the owner's permissions
 * there directly: one company's own systems, with the owner signed in.
 */
import { type CandidateElement, onet } from "@ojcp/credentials-core";
import type { Issuer } from "@ojcp/issuer";
import { Hono } from "hono";
import { z } from "zod";
import type { EventBus } from "../events.ts";
import { type PendingRequest, type SandboxWallet, WalletError } from "./wallet.ts";

const day = (s: number) =>
  new Date(s * 1000).toLocaleDateString("en", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

/** What the consent screen may show: everything except the keys and nonces. */
function view(r: PendingRequest) {
  return {
    id: r.id,
    verifier: r.verifier,
    application: r.application,
    share: r.share,
    withheld: r.withheld,
    warnings: r.warnings,
    expiresAt: r.expiresAt,
    hasRecord: r.recordId !== undefined,
  };
}

export function walletApp(
  wallet: SandboxWallet,
  permissions: { issuer: Issuer; owner: CandidateElement; events: EventBus; host: string },
): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof WalletError || error instanceof z.ZodError)
      return c.json(
        { error: error instanceof WalletError ? error.message : "Invalid request." },
        400,
      );
    throw error;
  });

  app.get("/api/wallet", (c) => c.json(wallet.summary()));

  app.post("/api/wallet/offer/preview", async (c) => {
    const { offer } = z.object({ offer: z.string() }).parse(await c.req.json());
    return c.json(await wallet.previewOffer(offer));
  });

  app.post("/api/wallet/offer/accept", async (c) => {
    const body = z
      .object({ offer: z.string(), tx_code: z.string().default("") })
      .parse(await c.req.json());
    const record = await wallet.acceptOffer(body.offer, body.tx_code);
    return c.json({ id: record.id });
  });

  app.post("/api/wallet/request/open", async (c) => {
    const body = z
      .object({ client_id: z.string(), request_uri: z.url({ protocol: /^https$/ }) })
      .parse(await c.req.json());
    return c.json(view(await wallet.openRequest(body.client_id, body.request_uri)));
  });

  app.post("/api/wallet/request/:id", async (c) => {
    const { decision } = z
      .object({ decision: z.enum(["share", "decline"]) })
      .parse(await c.req.json());
    return c.json({ redirect_uri: await wallet.respond(c.req.param("id"), decision) });
  });

  // ── Permissions the owner gave agents (RFC 0008), at this provider's permission service ──
  app.get("/api/wallet/permissions", async (c) => {
    const { issuer, owner } = permissions;
    const active = await issuer.authorizationsFor(owner);
    return c.json(
      active
        .sort((a, b) => b.approvedAt - a.approvedAt)
        .map((a) => ({
          id: a.id,
          agent: issuer.client(a.clientId)?.name ?? a.clientId,
          agentId: a.agentId,
          approvedAt: day(a.approvedAt),
          until: day(a.exp),
          jobs: a.dataset.job_families.map((f) => onet.title(f) ?? f),
          perEmployer: a.dataset.per_employer,
          total: a.dataset.applications_total,
        })),
    );
  });
  app.post("/api/wallet/permissions/:id/cancel", async (c) => {
    const { issuer, owner, events, host } = permissions;
    const id = c.req.param("id");
    const mine = (await issuer.authorizationsFor(owner)).find((a) => a.id === id);
    if (!mine) return c.json({ error: "No such permission." }, 404);
    await issuer.revokeAuthorization(id);
    const agent = issuer.client(mine.clientId)?.name ?? mine.clientId;
    wallet.activity.unshift({
      at: issuer.now(),
      kind: "declined",
      text: `Cancelled ${agent}'s permission to apply for you`,
    });
    events.emit({
      actor: "candidate",
      where: host,
      title: `Candidate cancelled ${agent}'s permission in their wallet. The permission service marks its credentials revoked at the next hourly epoch; employers and ${agent} stop accepting them then`,
      outcome: "ok",
    });
    return c.json({ ok: true });
  });

  return app;
}
