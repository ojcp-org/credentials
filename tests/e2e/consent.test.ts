/**
 * The permission service's consent, as an operator's own screen drives it
 * (RFC 0008 §3.3): `consentUi` hands the request to that screen, the JSON API
 * shows it in plain words and takes the decision, and one-time codes can't be
 * guessed by resending them.
 */
import { beginStandingMandate } from "@ojcp/agent-wallet";
import { describe, expect, it } from "vitest";
import { CLIENT_ID, createWorld, ISSUER, PROPOSAL, REDIRECT, type World } from "./harness.ts";

const EMAIL = "jordan@example.com";
const CODE_KEY = JSON.stringify({ email: EMAIL });

/** Starts an authorization and returns the pending id from the consentUi redirect. */
async function start(world: World): Promise<{ id: string; state: string }> {
  const { url, state } = await beginStandingMandate({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    proposal: PROPOSAL,
    fetch: world.issuerFetch,
  });
  const response = await world.issuerFetch(url);
  expect(response.status).toBe(303);
  const location = response.headers.get("location") ?? "";
  const id = location.match(/^https:\/\/wallet\.example\/permissions\/([A-Za-z0-9_-]+)$/)?.[1];
  expect(id).toBeTruthy();
  return { id: id as string, state };
}

const post = (world: World, path: string, body: unknown) =>
  world.issuerFetch(`${ISSUER}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("consent through an operator's own screen", () => {
  it("hands /authorize to consentUi, then approves through the JSON API", async () => {
    const world = await createWorld({ consentUi: "https://wallet.example/permissions/{id}" });
    const { id, state } = await start(world);

    const view = await (await world.issuerFetch(`${ISSUER}/api/consent/${id}`)).json();
    expect(view).toMatchObject({
      id,
      client: { name: "Northstar Assistant" },
      contacts: [{ value: CODE_KEY }],
      perEmployer: 2,
      total: 40,
    });

    expect((await post(world, `/api/consent/${id}/codes`, {})).status).toBe(200);
    const approved = await post(world, `/api/consent/${id}/approve`, {
      codes: { [CODE_KEY]: world.messenger.lastCodeFor(EMAIL) },
      selection: { per_employer: 1 },
    });
    expect(approved.status).toBe(200);
    const redirect = new URL((await approved.json()).redirect);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
    expect(redirect.searchParams.get("state")).toBe(state);
    expect(redirect.searchParams.get("code")).toBeTruthy();
    // The narrowing took: the authorization allows one per employer.
    const [authorization] = await world.issuer.authorizationsFor({ email: EMAIL });
    expect(authorization?.dataset.per_employer).toBe(1);
  });

  it("declines with access_denied and the agent's state", async () => {
    const world = await createWorld({ consentUi: "https://wallet.example/permissions/{id}" });
    const { id, state } = await start(world);
    const declined = await post(world, `/api/consent/${id}/deny`, {});
    const redirect = new URL((await declined.json()).redirect);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe(state);
    // The request is gone: it can't be approved afterwards.
    expect((await world.issuerFetch(`${ISSUER}/api/consent/${id}`)).status).toBe(404);
  });

  it("refuses a widening without spending the person's code", async () => {
    const world = await createWorld({ consentUi: "https://wallet.example/permissions/{id}" });
    const { id } = await start(world);
    await post(world, `/api/consent/${id}/codes`, {});
    const code = world.messenger.lastCodeFor(EMAIL);
    const widened = await post(world, `/api/consent/${id}/approve`, {
      codes: { [CODE_KEY]: code },
      selection: { per_employer: 3 },
    });
    expect(widened.status).toBe(400);
    // The same code still works for a valid choice.
    const approved = await post(world, `/api/consent/${id}/approve`, {
      codes: { [CODE_KEY]: code },
      selection: {},
    });
    expect(approved.status).toBe(200);
  });

  it("doesn't let resending a code buy more guesses", async () => {
    const world = await createWorld({ consentUi: "https://wallet.example/permissions/{id}" });
    const { id } = await start(world);
    const guess = () =>
      post(world, `/api/consent/${id}/approve`, { codes: { [CODE_KEY]: "000000" }, selection: {} });
    await post(world, `/api/consent/${id}/codes`, {});
    for (let i = 0; i < 5; i++) expect((await guess()).status).toBe(403);
    // A new code after five wrong guesses is still locked: the count carries over.
    await post(world, `/api/consent/${id}/codes`, {});
    const fresh = await post(world, `/api/consent/${id}/approve`, {
      codes: { [CODE_KEY]: world.messenger.lastCodeFor(EMAIL) },
      selection: {},
    });
    expect(fresh.status).toBe(403);
    // And codes stop after three sends.
    await post(world, `/api/consent/${id}/codes`, {});
    expect((await post(world, `/api/consent/${id}/codes`, {})).status).toBe(429);
  });
});
