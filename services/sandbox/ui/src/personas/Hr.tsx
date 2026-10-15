/**
 * Tab 1: where Jordan's work record comes from. Three places keep it and can
 * sign it (RFC 0014 §3), each its own company with its own site: WorkSecond,
 * the HR platform Vandelay uses (a wink at Workday); MDP, its payroll
 * provider (a wink at ADP); and Vandelay's own intranet. He's a current
 * employee, signed in, and can put a signed record of his job in his wallet
 * whenever he likes (§4.1).
 */
import { useEffect, useState } from "react";
import { api } from "../boot.ts";
import { MdpSite } from "./records/Mdp.tsx";
import { here, type Me, SourceStrip } from "./records/shared.tsx";
import { VandelaySite } from "./records/Vandelay.tsx";
import { WorkSecondSite } from "./records/WorkSecond.tsx";

export function Hr() {
  const [me, setMe] = useState<Me>();
  useEffect(() => {
    api<Me>("/api/hr/me").then(setMe);
  }, []);
  return (
    <>
      <SourceStrip />
      {here === "mdp" ? (
        <MdpSite me={me} />
      ) : here === "vandelay" ? (
        <VandelaySite me={me} />
      ) : (
        <WorkSecondSite me={me} />
      )}
    </>
  );
}
