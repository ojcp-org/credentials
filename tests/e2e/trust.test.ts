/**
 * RFC 0008 §5.3 with a real RFC 0010 derivation: the agent applies under a
 * standing mandate only once it has derived the provider's tier itself.
 */
import { StandingMandateHolder, StandingMandateRefusal } from "@ojcp/agent-wallet";
import { DerivedTrustResolver, TrustLists } from "@ojcp/trust";
import { describe, expect, it } from "vitest";
import {
  attester,
  provider,
  publisher,
  serveStatus,
  Web,
} from "../../sdks/typescript/trust/test/world.ts";
import { AGENT_ID, createWorld, job, obtainMandate, PROVIDER, START } from "./harness.ts";

describe("standing mandates under derived trust", () => {
  it("applies once two independent operators attest the provider, and not before", async () => {
    const world = await createWorld();
    const analyst = job({ ojcp_id: "careers.acme.com:analyst-1" });
    world.provider.jobs.set(analyst.ojcp_id, analyst);
    await obtainMandate(world);

    // The provider's origin on the web: signed manifest, identity key, staple.
    const web = new Web();
    const acme = await provider(web, PROVIDER);
    const kyb = await attester(web, "https://kyb.attester.example", "lei:5493001KJTIIGC8Y1R12");
    const registry = await attester(web, "https://registry-a.example.gov", "gov:registry-a");
    for (const a of [kyb, registry]) await serveStatus(web, a);
    const pub = await publisher("lists.candidate-advocates.example");
    const trustLists = new TrustLists([{ name: "Candidate advocates", pins: [pub.pin] }]);
    expect(
      await trustLists.accept(
        await pub.sign({ attesters: [kyb.entry(), registry.entry(["business_registration"])] }),
        START,
      ),
    ).toBe("accepted");

    const trust = new DerivedTrustResolver({
      lists: trustLists,
      fetch: web.fetch,
      now: () => world.clock.now,
    });
    const holder = new StandingMandateHolder({
      keyring: world.keyring,
      agentId: AGENT_ID,
      trust,
      store: world.holderStore,
      now: () => world.clock.now,
    });
    const begin = () =>
      holder.exercise({
        tool: "begin_application",
        origin: PROVIDER,
        ojcpVersion: "0.3",
        job: analyst,
        employerId: "acme-corp",
        request: {
          candidate_context: { consent_scope: "application_prefill", email: "jordan@example.com" },
        },
        consentScope: "application_prefill",
      });

    // Only one operator: the derived tier is unverified, so the agent refuses.
    acme.staple([await kyb.issue("legal_entity", acme)]);
    await expect(begin()).rejects.toBeInstanceOf(StandingMandateRefusal);
    await expect(begin()).rejects.toMatchObject({ reason: "trust" });

    // A second, independent operator: verified, derived, so the agent may apply.
    acme.staple([
      await kyb.issue("legal_entity", acme),
      await registry.issue("business_registration", acme),
    ]);
    trust.invalidate();
    expect(await trust.effectiveTier(PROVIDER)).toMatchObject({
      tier: "verified",
      source: "derived",
    });
    const exercised = await begin();
    expect(exercised.userMandate.split("~").length).toBeGreaterThan(2);
  });
});
