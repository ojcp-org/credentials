/**
 * What the three record keepers' sites share: the signed-in employee, adding
 * the record to the wallet, what the record does and what the keeper vouches
 * for, and the sandbox strip that moves between them. Each site lays these
 * out in its own way.
 */
import { Anchor, Box, Group, List, Text } from "@mantine/core";
import { useState } from "react";
import { api, boot, type Role } from "../../boot.ts";
import { OJCP } from "../../theme.ts";

export interface Me {
  platform: string;
  role: string;
  employer: { name: string; id: string };
  employee: { name: string; email: string };
  record: {
    current: boolean;
    start: string;
    positionHistories: Array<{ title: string; start: string; end?: string }>;
  };
  basis: "customer_records" | "own_records";
  issuer: string;
}

export const SOURCE_ROLES = ["hr", "mdp", "vandelay"] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];
const isSource = (r: Role): r is SourceRole => (SOURCE_ROLES as readonly Role[]).includes(r);
export const here: SourceRole = isSource(boot.role) ? boot.role : "hr";
export const page: "records" | "practice" =
  location.pathname === "/practice" ? "practice" : "records";

export const month = (d: string) =>
  new Date(`${d.length === 7 ? `${d}-01` : d}T00:00:00Z`).toLocaleDateString("en", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

export const currentTitle = (me: Me) => me.record.positionHistories.at(-1)?.title ?? "";

/** Asks this site for a one-time offer and opens the wallet with it, as a phone would. */
export function useAddToWallet() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function add() {
    setBusy(true);
    setError(undefined);
    try {
      const { offerUri } = await api<{ offerUri: string }>("/api/hr/wallet-offer", {});
      location.href = `${boot.origins.wallet}/offer${offerUri.slice(offerUri.indexOf("?"))}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  return { add, busy, error };
}

/** What the record does for the employee, in this keeper's voice. */
export function promises(me: Me): string[] {
  return [
    "A future employer can confirm where you work, your job titles and how long you've been here, without calling anyone.",
    "You share only what an employer asks for. Exact dates and the rest stay in your wallet.",
    `${me.basis === "own_records" ? "Your manager and HR aren't" : `${me.employer.name} isn't`} told when or where you use it. Employers check its status against a shared list, fetched on a schedule.`,
    "It never includes pay, ratings or reasons for leaving.",
  ];
}

/** Who signs, and on what basis (RFC 0014 §3). */
export function signedBy(me: Me): string {
  return me.basis === "own_records"
    ? `Signed by ${me.platform} itself, from its own personnel records.`
    : `Signed by ${me.platform}, reporting what ${me.employer.name} recorded in our system.`;
}

/** The keeper's published practice (RFC 0014 §6). */
export function Vouch({ me }: { me: Me }) {
  return (
    <List spacing="sm" size="sm">
      <List.Item>
        <b>Basis:</b> <code>{me.basis}</code>.{" "}
        {me.basis === "own_records"
          ? "We sign our own personnel records, as the employer (RFC 0014 §3)."
          : "We sign in our own name, reporting what our customer recorded (RFC 0014 §3)."}
      </List.Item>
      {me.basis === "customer_records" && (
        <List.Item>
          <b>Customers:</b> we confirm each customer's business registration before it can issue
          records through us.
        </List.Item>
      )}
      <List.Item>
        <b>Status:</b> we update a record's status within 7 days of the change that ends it.
      </List.Item>
      <List.Item>
        <b>Keys:</b> published at <code>{me.issuer}/.well-known/jwt-vc-issuer</code>, each with the
        date we stop signing with it.
      </List.Item>
      <List.Item>
        <b>Consumer reporting:</b> we don't act as a consumer reporting agency for these records.
      </List.Item>
    </List>
  );
}

const KEEPERS: Record<SourceRole, { name: string; what: string }> = {
  hr: { name: "WorkSecond", what: "HR platform" },
  mdp: { name: "MDP", what: "payroll" },
  vandelay: { name: "Vandelay", what: "its own records" },
};

/**
 * Sandbox chrome, not part of any company's site: the same record is kept in
 * three places, each a separate company, and this moves between them.
 */
export function SourceStrip() {
  return (
    <Box bg={OJCP.surface} style={{ borderBottom: "1px solid #28282f" }} px="md" py={6}>
      <Group gap={6} justify="center" wrap="wrap">
        <Text size="xs" c={OJCP.muted}>
          Jordan's record is kept in three places, each a different company:
        </Text>
        {SOURCE_ROLES.map((r, i) => (
          <Group key={r} gap={6} wrap="nowrap">
            {i > 0 && (
              <Text size="xs" c={OJCP.muted}>
                ·
              </Text>
            )}
            {r === here ? (
              <Text size="xs" fw={700} c={OJCP.gold}>
                {KEEPERS[r].name} ({KEEPERS[r].what}), you're here
              </Text>
            ) : (
              <Anchor size="xs" c={OJCP.text} href={`${boot.origins[r]}/`} underline="always">
                {KEEPERS[r].name} ({KEEPERS[r].what})
              </Anchor>
            )}
          </Group>
        ))}
      </Group>
    </Box>
  );
}
