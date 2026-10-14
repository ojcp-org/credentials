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
import { base64url, type CandidateElement, onet, randomBytes } from "@ojcp/credentials-core";
import { type Issuer, ProtocolError } from "@ojcp/issuer";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
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

/** The owner's session with their wallet app. */
const SESSION = "wallet_session";

/** The permission service the wallet provider runs for its owner (RFC 0008). */
export interface WalletPermissions {
  issuer: Issuer;
  owner: CandidateElement;
  events: EventBus;
  host: string;
}

export function walletApp(wallet: SandboxWallet, permissions: WalletPermissions): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ProtocolError)
      return c.json({ error: error.message }, error.status === 404 ? 404 : 400);
    if (error instanceof WalletError || error instanceof z.ZodError)
      return c.json(
        { error: error instanceof WalletError ? error.message : "Invalid request." },
        400,
      );
    throw error;
  });

  // Only the owner's device has a session: the app sets it when it opens on
  // their phone (in the sandbox, when a wallet page loads). Anyone else, an
  // agent platform calling server to server included, has no way to act as
  // the owner, so it can't approve a permission or read their records.
  const session = base64url(randomBytes(32));
  app.get("/_session", (c) => {
    setCookie(c, SESSION, session, { httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
    return c.body(null, 204);
  });
  app.use("/api/wallet/*", async (c, next) => {
    if (getCookie(c, SESSION) !== session)
      return c.json({ error: "Open this in your wallet app." }, 401);
    await next();
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

  // ── The permission service's consent screen, as a wallet screen (RFC 0008 §3.3) ──
  // The wallet account already verified the owner's email, and the app is
  // unlocked with their biometrics, so approving needs no one-time code.
  const Selection = z.object({
    job_families: z.array(z.string()).optional(),
    locations: z.array(z.string()).optional(),
    remote_policy: z.array(z.string()).optional(),
    actions: z.array(z.string()).optional(),
    per_employer: z.number().int().optional(),
    applications_total: z.number().int().optional(),
  });
  app.get("/api/wallet/consent/:id", async (c) => {
    const view = await permissions.issuer.consent(c.req.param("id"));
    if (!view) return c.json({ error: "This request has expired. Ask your assistant again." }, 404);
    return c.json(view);
  });
  app.post("/api/wallet/consent/:id/approve", async (c) => {
    const { selection } = z.object({ selection: Selection }).parse(await c.req.json());
    const { issuer, owner, events, host } = permissions;
    const redirect = await issuer.approveSignedIn(c.req.param("id"), [owner], selection);
    events.emit({
      actor: "candidate",
      where: host,
      title:
        "Candidate approved the permission in their wallet with Face ID. The wallet account had already verified their email, so no code was needed",
      outcome: "ok",
    });
    return c.json({ redirect });
  });
  app.post("/api/wallet/consent/:id/decline", async (c) =>
    c.json({ redirect: await permissions.issuer.deny(c.req.param("id")) }),
  );

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
    if (!(await cancelPermission(wallet, permissions, c.req.param("id"))))
      return c.json({ error: "No such permission." }, 404);
    return c.json({ ok: true });
  });

  return app;
}

/**
 * The owner cancels a permission they gave an agent. Returns false if it isn't theirs.
 * Used by the wallet's Permissions screen and by the lab's "Jordan cancels".
 */
export async function cancelPermission(
  wallet: SandboxWallet,
  permissions: WalletPermissions,
  id: string,
): Promise<boolean> {
  const { issuer, owner, events, host } = permissions;
  const mine = (await issuer.authorizationsFor(owner)).find((a) => a.id === id);
  if (!mine) return false;
  await issuer.revokeAuthorization(id);
  // A real service publishes at its next hourly epoch (RFC 0008 §7.1). The
  // sandbox publishes a cancellation at once, so its effect can be watched.
  await issuer.status.applyEpoch();
  const agent = issuer.client(mine.clientId)?.name ?? mine.clientId;
  wallet.activity.unshift({
    at: issuer.now(),
    kind: "declined",
    text: `Cancelled ${agent}'s permission to apply for you`,
  });
  events.emit({
    actor: "candidate",
    where: host,
    title: `Candidate cancelled ${agent}'s permission in their wallet. The permission service published the change to its status list (a real one does so at its next hourly epoch); ${agent} and employers stop accepting the credentials when they next check`,
    outcome: "ok",
  });
  return true;
}
