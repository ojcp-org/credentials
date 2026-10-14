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

  if (config.notice) {
    const banner = `<div role="note" style="background:#fff3cd;border:1px solid #e0c36b;padding:.5rem .75rem;margin-bottom:1rem">${escapeHtml(config.notice)}</div>`;
    app.use("*", async (c, next) => {
      await next();
      if (!c.res.headers.get("content-type")?.startsWith("text/html")) return;
      const html = (await c.res.text()).replace("<body>", `<body>${banner}`);
      c.res = new Response(html, c.res);
    });
  }

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
    if (config.consentUi)
      return c.redirect(config.consentUi.replace("{id}", encodeURIComponent(pending.id)), 303);
    return c.html(
      <ConsentPage
        pendingId={pending.id}
        client={client}
        dataset={pending.dataset}
        expiry={expiryFor(issuer, pending.dataset.months)}
        codesSent={false}
        host={new URL(config.issuer).host}
      />,
    );
  });

  // The same consent as JSON, for an operator's own screen (`consentUi`).
  const consentFor = async (id: string) => {
    const view = await issuer.consent(id);
    if (!view)
      throw new ProtocolError(
        "invalid_request",
        "This request has expired. Start again from your agent.",
        404,
      );
    return view;
  };
  const ConsentDecision = z.object({
    codes: z.record(z.string(), z.string()),
    selection: z.object({
      job_families: z.array(z.string()).optional(),
      locations: z.array(z.string()).optional(),
      remote_policy: z.array(z.string()).optional(),
      actions: z.array(z.string()).optional(),
      per_employer: z.number().int().optional(),
      applications_total: z.number().int().optional(),
    }),
  });
  app.get("/api/consent/:id", async (c) => c.json(await consentFor(c.req.param("id"))));
  app.post("/api/consent/:id/codes", async (c) => {
    const id = c.req.param("id");
    await consentFor(id);
    await issuer.sendCodes(id);
    return c.json({ sent: true });
  });
  app.post("/api/consent/:id/approve", async (c) => {
    const body = ConsentDecision.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) throw new ProtocolError("invalid_request", "malformed decision");
    const redirect = await issuer.approve(c.req.param("id"), body.data.codes, body.data.selection);
    return c.json({ redirect });
  });
  app.post("/api/consent/:id/deny", async (c) =>
    c.json({ redirect: await issuer.deny(c.req.param("id")) }),
  );

  /** The person's choices so far, read from the consent form. */
  const selectionOf = (form: FormData): Narrowing => ({
    job_families: form.getAll("job_families").map(String),
    locations: form.getAll("locations").map(String),
    remote_policy: form.getAll("remote_policy").map(String),
    actions: form.getAll("actions").map(String),
    per_employer: Number(form.get("per_employer")),
    applications_total: Number(form.get("applications_total")),
  });

  app.post("/authorize/:id/send-codes", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.formData();
    if (form.get("decision") === "deny") return c.redirect(await issuer.deny(id), 303);
    await issuer.sendCodes(id);
    return renderConsent(c, id, true, undefined, selectionOf(form));
  });

  app.post("/authorize/:id/approve", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.formData();
    if (form.get("decision") === "deny") return c.redirect(await issuer.deny(id), 303);
    const codes: Record<string, string> = {};
    for (const [key, value] of Object.entries(formStrings(form)))
      if (key.startsWith("code:")) codes[key.slice(5)] = value;
    const narrowing = selectionOf(form);
    try {
      return c.redirect(await issuer.approve(id, codes, narrowing), 303);
    } catch (error) {
      if (error instanceof ProtocolError && error.status !== 404)
        return renderConsent(c, id, true, error.message, narrowing);
      throw error;
    }
  });

  async function renderConsent(
    c: Context,
    id: string,
    codesSent: boolean,
    error?: string,
    selected?: Narrowing,
  ) {
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
        host={new URL(config.issuer).host}
        {...(error ? { error } : {})}
        {...(selected ? { selected } : {})}
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
  // An operator with its own permissions screen (a wallet provider, say) sends
  // people there; registered first, these routes take the built-in pages' place.
  if (config.accountUi) {
    const to = config.accountUi;
    app.get("/", (c) => c.redirect(to, 303));
    app.get("/account", (c) => c.redirect(to, 303));
    app.all("/account/*", (c) => c.redirect(to, 303));
  }
  // A person who opens the issuer directly is here to see or cancel permissions.
  app.get("/", (c) => c.redirect("/account"));
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
