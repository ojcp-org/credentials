/** @jsxImportSource hono/jsx */
/** HTTP surface of the issuer. Protocol logic lives in `Issuer`. */
import { CandidateElement, monthEpochs, normalizeCandidate } from "@ojcp/credentials-core";
import { type Context, Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { type Issuer, type Narrowing, ProtocolError } from "./issuer.ts";
import {
  AccountCodePage,
  AccountPage,
  AccountStartPage,
  ConsentPage,
  MessagePage,
} from "./pages.tsx";

const ACCOUNT_COOKIE = "ojcp_account";

const RecordBody = z.strictObject({
  type: z.enum(["employment", "education", "professional_license", "certification"]),
  basis: z.enum(["own_records", "customer_records", "source_check"]),
  record: z.record(z.string(), z.unknown()),
  holderName: z
    .strictObject({ given_name: z.string().optional(), family_name: z.string().optional() })
    .optional(),
  personalEmail: z.email().optional(),
  personalPhone: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/)
    .optional(),
});

function formStrings(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  form.forEach((value, key) => {
    if (typeof value === "string") out[key] = value;
  });
  return out;
}

function parseIdentifier(text: string): CandidateElement | undefined {
  const value = text.trim();
  const parsed = CandidateElement.safeParse(
    value.includes("@")
      ? { email: value.toLowerCase() }
      : { phone: value.replace(/[\s().-]/g, "") },
  );
  return parsed.success ? normalizeCandidate(parsed.data) : undefined;
}

export function createApp(issuer: Issuer): Hono {
  const app = new Hono();
  const { config } = issuer;

  app.use(
    "*",
    secureHeaders({
      xFrameOptions: "DENY",
      contentSecurityPolicy: {
        frameAncestors: ["'none'"],
        defaultSrc: ["'self'"],
        styleSrc: ["'unsafe-inline'"],
      },
    }),
  );

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof ProtocolError) {
      c.header("cache-control", "no-store");
      return c.json(error.toJSON(), error.status as 400);
    }
    console.error(error);
    return c.json({ error: "server_error" }, 500);
  });

  // ── Metadata ─────────────────────────────────────────────────────────────
  app.get("/.well-known/openid-credential-issuer", async (c) =>
    c.json(await issuer.credentialIssuerMetadata()),
  );
  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json(issuer.authorizationServerMetadata()),
  );
  app.get("/.well-known/jwt-vc-issuer", async (c) => c.json(await issuer.jwtVcIssuerMetadata()));

  // ── Consent (RFC 0008 §3.3) ──────────────────────────────────────────────
  app.get("/authorize", async (c) => {
    const pending = await issuer.startAuthorization(c.req.query());
    const client = issuer.client(pending.clientId);
    if (!client) throw new ProtocolError("unauthorized_client", "unknown client");
    return c.html(
      <ConsentPage
        pendingId={pending.id}
        client={client}
        dataset={pending.dataset}
        expiry={expiryFor(issuer, pending.dataset.months)}
        codesSent={false}
      />,
    );
  });

  app.post("/authorize/:id/send-codes", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.formData();
    if (form.get("decision") === "deny") return c.redirect(await issuer.deny(id), 303);
    await issuer.sendCodes(id);
    return renderConsent(c, id, true);
  });

  app.post("/authorize/:id/approve", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.formData();
    if (form.get("decision") === "deny") return c.redirect(await issuer.deny(id), 303);
    const codes: Record<string, string> = {};
    for (const [key, value] of Object.entries(formStrings(form)))
      if (key.startsWith("code:")) codes[key.slice(5)] = value;
    const narrowing: Narrowing = {
      job_families: form.getAll("job_families").map(String),
      locations: form.getAll("locations").map(String),
      remote_policy: form.getAll("remote_policy").map(String),
      actions: form.getAll("actions").map(String),
      per_employer: Number(form.get("per_employer")),
      applications_total: Number(form.get("applications_total")),
    };
    try {
      return c.redirect(await issuer.approve(id, codes, narrowing), 303);
    } catch (error) {
      if (error instanceof ProtocolError && error.status !== 404)
        return renderConsent(c, id, true, error.message);
      throw error;
    }
  });

  async function renderConsent(c: Context, id: string, codesSent: boolean, error?: string) {
    const pending = await issuer.pending(id);
    if (!pending)
      return c.html(
        <MessagePage title="This request has expired" message="Start again from your agent." />,
        404,
      );
    const client = issuer.client(pending.clientId);
    if (!client) throw new ProtocolError("unauthorized_client", "unknown client");
    return c.html(
      <ConsentPage
        pendingId={id}
        client={client}
        dataset={pending.dataset}
        expiry={expiryFor(issuer, pending.dataset.months)}
        codesSent={codesSent}
        {...(error ? { error } : {})}
      />,
      error ? 400 : 200,
    );
  }

  // ── OpenID4VCI endpoints ─────────────────────────────────────────────────
  app.post("/token", async (c) => {
    c.header("cache-control", "no-store");
    return c.json(await issuer.token(formStrings(await c.req.formData())));
  });

  app.post("/nonce", async (c) => {
    c.header("cache-control", "no-store");
    return c.json({ c_nonce: await issuer.nonce() });
  });

  app.post("/credential", async (c) => {
    const auth = c.req.header("authorization");
    const accessToken = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    c.header("cache-control", "no-store");
    return c.json(await issuer.credential(accessToken, await c.req.json()));
  });

  app.get("/offers/:id", async (c) => {
    const offer = await issuer.credentialOffer(c.req.param("id"));
    return offer ? c.json(offer) : c.json({ error: "not_found" }, 404);
  });

  // ── Status lists ─────────────────────────────────────────────────────────
  app.get("/status/:list", async (c) => {
    const token = await issuer.status.token(
      new URL(c.req.path, config.issuer).toString(),
      new Date(issuer.now() * 1000),
    );
    if (!token) return c.notFound();
    return c.body(token, 200, {
      "content-type": "application/statuslist+jwt",
      "cache-control": "public, max-age=3600",
    });
  });

  // ── Account: revocation (RFC 0008 §7.2) ──────────────────────────────────
  app.get("/account", (c) => c.html(<AccountStartPage />));

  app.post("/account/code", async (c) => {
    const identifier = parseIdentifier(String((await c.req.formData()).get("identifier") ?? ""));
    if (!identifier)
      return c.html(
        <AccountStartPage error="Enter an email address or a phone number in international format." />,
        400,
      );
    const challenge = await issuer.sendAccountCode(identifier);
    await setSignedCookie(
      c,
      `${ACCOUNT_COOKIE}_pending`,
      JSON.stringify({ challenge, identifier }),
      config.cookieSecret,
      {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/account",
        maxAge: 600,
      },
    );
    return c.html(<AccountCodePage challenge={challenge} />);
  });

  app.post("/account/verify", async (c) => {
    const form = await c.req.formData();
    const pending = await getSignedCookie(c, config.cookieSecret, `${ACCOUNT_COOKIE}_pending`);
    const state = pending ? AccountChallenge.safeParse(JSON.parse(pending)).data : undefined;
    if (
      !state ||
      state.challenge !== form.get("challenge") ||
      !(await issuer.checkAccountCode(state.challenge, String(form.get("code") ?? "")))
    )
      return c.html(<AccountStartPage error="That code is wrong or has expired." />, 403);
    deleteCookie(c, `${ACCOUNT_COOKIE}_pending`, { path: "/account" });
    await setSignedCookie(
      c,
      ACCOUNT_COOKIE,
      JSON.stringify(state.identifier),
      config.cookieSecret,
      {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/account",
        maxAge: 900,
      },
    );
    return c.redirect("/account/mandates", 303);
  });

  async function signedInIdentifier(c: Context): Promise<CandidateElement | undefined> {
    const raw = await getSignedCookie(c, config.cookieSecret, ACCOUNT_COOKIE);
    if (!raw) return undefined;
    const parsed = CandidateElement.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  }

  app.get("/account/mandates", async (c) => {
    const identifier = await signedInIdentifier(c);
    if (!identifier) return c.redirect("/account", 303);
    const authorizations = (await issuer.authorizationsFor(identifier)).map((authorization) => {
      const client = issuer.client(authorization.clientId);
      return client ? { authorization, client } : { authorization };
    });
    return c.html(<AccountPage authorizations={authorizations} />);
  });

  app.post("/account/revoke/:id", async (c) => {
    const identifier = await signedInIdentifier(c);
    if (!identifier) return c.redirect("/account", 303);
    const id = c.req.param("id");
    const owned = (await issuer.authorizationsFor(identifier)).some((a) => a.id === id);
    if (!owned)
      return c.html(
        <MessagePage title="Not found" message="That mandate isn't one of yours." />,
        404,
      );
    await issuer.revokeAuthorization(id);
    return c.html(
      <MessagePage
        title="Cancelled"
        message="Your agent can no longer use this mandate. Employers' systems stop accepting it within about two hours."
      />,
    );
  });

  // ── Former employees, route 3 (RFC 0014 §5.3) ────────────────────────────
  app.post("/alumni", async (c) => {
    const email = String((await c.req.formData()).get("email") ?? "");
    if (z.email().safeParse(email).success) await issuer.alumniRequest(email);
    return c.html(
      <MessagePage
        title="Check your email"
        message="If that address is on record, we've sent a new offer to it."
      />,
    );
  });

  // ── Record-holder API (HRIS integration) ─────────────────────────────────
  if (config.adminToken) {
    const admin = new Hono();
    admin.use("*", bearerAuth({ token: config.adminToken }));
    admin.put("/records/:id", async (c) => {
      const body = RecordBody.safeParse(await c.req.json());
      if (!body.success) throw new ProtocolError("invalid_request", "invalid record");
      const { holderName, personalEmail, personalPhone, ...rest } = body.data;
      const stored = await issuer.putRecord({
        id: c.req.param("id"),
        ...rest,
        ...(holderName ? { holderName } : {}),
        ...(personalEmail ? { personalEmail } : {}),
        ...(personalPhone ? { personalPhone } : {}),
      });
      return c.json(stored);
    });
    admin.post("/records/:id/offer", async (c) => c.json(await issuer.offer(c.req.param("id"))));
    admin.post("/records/:id/offboard", async (c) => {
      const body = z
        .object({ end: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/) })
        .safeParse(await c.req.json());
      if (!body.success) throw new ProtocolError("invalid_request", "end date required");
      return c.json(await issuer.offboard(c.req.param("id"), body.data.end));
    });
    admin.post("/records/:id/revoke", async (c) =>
      c.json({ revoked: await issuer.revokeRecord(c.req.param("id")) }),
    );
    app.route("/admin", admin);
  }

  return app;
}

const AccountChallenge = z.strictObject({ challenge: z.string(), identifier: CandidateElement });

function expiryFor(issuer: Issuer, months: 1 | 2 | 3): Date {
  return new Date(monthEpochs(new Date(issuer.now() * 1000), months).exp * 1000);
}
