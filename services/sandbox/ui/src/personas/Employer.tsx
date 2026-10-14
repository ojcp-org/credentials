/**
 * Tab 4: the employer. Acme's careers site, the page where a candidate confirms
 * their work history (RFC 0013's verification_url), and what Acme's recruiters
 * see in their ATS. The other job sites in the sandbox render their job lists here too.
 */
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  Container,
  Group,
  List,
  Loader,
  Paper,
  PinInput,
  SimpleGrid,
  Stack,
  Stepper,
  Tabs,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconClipboardCheck,
  IconEyeOff,
  IconFingerprint,
  IconInbox,
  IconMail,
  IconRobot,
  IconShieldCheck,
  IconWallet,
} from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { api, boot } from "../boot.ts";
import { ACME, AcmeMark, AcmeWordmark, BLUEHOUSE, BlueHouseMark } from "../brands.tsx";

interface Site {
  name: string;
  host: string;
  employers: string[];
  jobs: Array<{
    ojcp_id: string;
    title: string;
    description: string;
    remote_policy: string;
    baseSalary?: { minValue?: number; maxValue?: number };
    employer: { name: string };
    asks_for_work_history: boolean;
  }>;
}

interface VerifyView {
  ref: string;
  employer: string;
  job: string;
  masked_contact: string;
  purpose: string;
  asks: string[];
  status: "pending" | "completed" | "deferred" | "expired";
  declined: boolean;
  bound: boolean;
  code_sent: boolean;
  awaiting_confirmation: boolean;
  mismatch?: boolean;
  exhausted?: boolean;
  result?: {
    basis: string;
    issuer: string;
    shared: Array<{ label: string; value: string }>;
  };
}

interface Received {
  applicationId: string;
  at: number;
  job: { id: string; title: string };
  employer: string;
  mandate: "standing" | "action";
  learned: Record<string, unknown>;
  /** Names of the occupation codes the permission disclosed. */
  occupations: string[];
  contact?: string;
  coverLetter?: string;
  workHistory?: {
    status: "completed" | "deferred" | "pending";
    requirement?: string;
    check?: { outcome: "confirmed" | "not_confirmed"; note: string; at: number };
    kept?: {
      record: Record<string, unknown>;
      issuer: string;
      basis: string;
      presentationSha256: string;
    };
  };
}

const isAcme = boot.role === "acme";
/** The lookalike copies Acme's look; that's the point of it. */
const looksAcme = isAcme || boot.role === "lookalike";
const onBlueHouse = boot.role === "ats" || boot.role === "globex";
const money = (n?: number) => (n === undefined ? "" : `$${Math.round(n / 1000)}k`);

function Header({ site, tab }: { site: Site | undefined; tab: "jobs" | "ats" | "verify" }) {
  return (
    <Box
      bg="white"
      style={{
        borderBottom: looksAcme
          ? `3px solid ${ACME.red}`
          : onBlueHouse
            ? `3px solid ${BLUEHOUSE.blue}`
            : "1px solid #eceef1",
      }}
    >
      <Container size="lg" py="sm">
        <Group justify="space-between">
          <Group gap="sm">
            {looksAcme ? (
              <AcmeMark />
            ) : onBlueHouse ? (
              <BlueHouseMark />
            ) : (
              <ThemeIcon size={32} radius="md" color="gray">
                <Text fw={800}>{(site?.name ?? "?").slice(0, 1)}</Text>
              </ThemeIcon>
            )}
            <Box>
              {looksAcme ? (
                <AcmeWordmark />
              ) : (
                <Text fw={700} lh={1.1} c={onBlueHouse ? BLUEHOUSE.deep : undefined}>
                  {/* The subtitle already says who hosts it. */}
                  {(site?.name ?? "").replace(/ \(hosted by [^)]+\)$/, "")}
                </Text>
              )}
              <Text size="xs" c="dimmed">
                {onBlueHouse ? "Careers, powered by BlueHouse" : "Careers"} · {location.host}
              </Text>
            </Box>
          </Group>
          {isAcme && tab !== "verify" && (
            <Tabs
              value={tab}
              variant="pills"
              radius="xl"
              onChange={(v) => {
                location.href = v === "ats" ? "/ats" : "/";
              }}
            >
              <Tabs.List>
                <Tabs.Tab value="jobs">Jobs</Tabs.Tab>
                <Tabs.Tab value="ats" leftSection={<IconInbox size={14} />}>
                  Recruiter view (ATS)
                </Tabs.Tab>
              </Tabs.List>
            </Tabs>
          )}
        </Group>
      </Container>
    </Box>
  );
}

function Jobs({ site }: { site: Site }) {
  return (
    <Stack gap="lg">
      <Box>
        <Title order={2}>
          {isAcme ? "Work at Acme" : `Jobs at ${site.employers.join(" and ")}`}
        </Title>
        <Text c="dimmed">{site.jobs.length} open roles</Text>
      </Box>
      {isAcme && (
        <Alert
          variant="light"
          color="gray"
          icon={<IconRobot color={ACME.red} />}
          styles={{ root: { background: ACME.cream, border: "1px solid #f3e2c4" } }}
        >
          We accept applications from AI assistants through OJCP, when they carry the candidate's
          permission. Some roles ask you to confirm your work history with your wallet; you can
          always choose not to.
        </Alert>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {site.jobs.map((j) => (
          <Paper key={j.ojcp_id} withBorder radius="md" p="md">
            <Text fw={700}>{j.title}</Text>
            <Text size="sm" c="dimmed">
              {j.employer.name} · {j.remote_policy.replace("_", " ")} ·{" "}
              {money(j.baseSalary?.minValue)}–{money(j.baseSalary?.maxValue)}
            </Text>
            <Text size="sm" mt={6}>
              {j.description}
            </Text>
            {j.asks_for_work_history && (
              <Badge mt="sm" variant="light" leftSection={<IconFingerprint size={12} />}>
                Asks you to confirm your work history
              </Badge>
            )}
          </Paper>
        ))}
      </SimpleGrid>
    </Stack>
  );
}

function Verify({ appRef: code }: { appRef: string }) {
  const [v, setV] = useState<VerifyView>();
  const [error, setError] = useState<string>();
  const [pin, setPin] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [otherDevice, setOtherDevice] = useState<string>();
  const params = new URLSearchParams(location.search);
  const responseCode = params.get("response_code");

  useEffect(() => {
    const load = responseCode
      ? api<VerifyView>(`/api/verify/${code}/complete`, { response_code: responseCode })
      : api<VerifyView>(`/api/verify/${code}`);
    load.then(setV, (e: Error) => setError(e.message));
  }, [code, responseCode]);

  async function call(path: string, body: unknown = {}) {
    setBusy(true);
    setError(undefined);
    try {
      return await api<VerifyView & { request_uri?: string; client_id?: string }>(
        `/api/verify/${code}/${path}`,
        body,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  if (!v) return error ? <Alert color="red">{error}</Alert> : <Loader />;
  const settled = v.status !== "pending";
  const active = settled ? 2 : v.bound ? 1 : 0;
  const unboundReturn = v.awaiting_confirmation && !v.bound && !settled;

  return (
    <Stack gap="lg" maw={720}>
      <Box>
        <Text size="sm" c="dimmed">
          Application <Code>{v.ref}</Code> · {v.job}
        </Text>
        <Title order={2}>Confirm your work history</Title>
      </Box>
      <Paper withBorder radius="md" p="md" bg={isAcme ? ACME.cream : BLUEHOUSE.tint}>
        <Text size="sm">{v.purpose}</Text>
      </Paper>
      {error && <Alert color="red">{error}</Alert>}
      {unboundReturn ? (
        <Paper withBorder radius="md" p="lg">
          <Text fw={600}>One more check</Text>
          <Text size="sm" c="dimmed" mb="sm">
            Your wallet answered from a different browser. Type the email you're applying with (
            {v.masked_contact}) so we know this is your application.
          </Text>
          {v.mismatch && (
            <Alert color="red" mb="sm">
              {v.exhausted
                ? "That didn't match three times, so we've set this answer aside. Confirm your email on this page, then share from your wallet again."
                : "That isn't the email on this application. Check it and try again."}
            </Alert>
          )}
          <Group>
            <TextInput
              value={contact}
              onChange={(e) => setContact(e.currentTarget.value)}
              placeholder="you@example.com"
            />
            <Button
              loading={busy}
              onClick={async () => {
                const r = await call("confirm-contact", { response_code: responseCode, contact });
                if (r) setV(r);
              }}
            >
              Confirm
            </Button>
          </Group>
        </Paper>
      ) : (
        <Stepper active={active} size="sm">
          <Stepper.Step
            label="Confirm it's you"
            description={`We send a code to ${v.masked_contact}`}
            icon={<IconMail size={18} />}
          >
            {!v.code_sent ? (
              <Button
                loading={busy}
                onClick={async () => {
                  const r = await call("code");
                  if (r) setV(r);
                }}
              >
                Send me a code
              </Button>
            ) : (
              <Stack gap="xs">
                <Text size="sm" c="dimmed">
                  Check Jordan's inbox at the top of the page.
                </Text>
                <Group>
                  <PinInput length={6} type="number" value={pin} onChange={setPin} />
                  <Button
                    loading={busy}
                    disabled={pin.length < 6}
                    onClick={async () => {
                      const r = await call("session", { code: pin });
                      if (r) setV(r);
                      else {
                        // An expired or used-up code is cleared: show "Send me a code" again.
                        setPin("");
                        api<VerifyView>(`/api/verify/${code}`).then(setV, () => undefined);
                      }
                    }}
                  >
                    Confirm
                  </Button>
                </Group>
              </Stack>
            )}
          </Stepper.Step>
          <Stepper.Step
            label="Share from your wallet"
            description="Only what's listed below"
            icon={<IconWallet size={18} />}
          >
            <Stack gap="sm">
              {v.declined && (
                <Alert color="yellow">
                  You chose not to share. You can try again, or continue without a wallet.
                </Alert>
              )}
              <Group gap={6}>
                <Text size="sm">We'll ask your wallet for:</Text>
                {v.asks.map((x) => (
                  <Badge key={x} variant="outline" color="gray">
                    {x}
                  </Badge>
                ))}
              </Group>
              <Group>
                <Button
                  leftSection={<IconWallet size={16} />}
                  loading={busy}
                  onClick={async () => {
                    const r = await call("wallet");
                    if (r?.client_id && r.request_uri)
                      location.href = `${boot.origins.wallet}/authorize?${new URLSearchParams({ client_id: r.client_id, request_uri: r.request_uri })}`;
                  }}
                >
                  Open my wallet
                </Button>
                <Button
                  variant="default"
                  loading={busy}
                  onClick={async () => {
                    const r = await call("skip");
                    if (r) setV(r);
                  }}
                >
                  Continue without a wallet
                </Button>
              </Group>
              <Text size="xs" c="dimmed">
                On a phone, this opens your wallet app. Continuing without one is fine: we check
                another way after you apply, and it doesn't count against you.
              </Text>
              <Anchor
                size="xs"
                component="button"
                onClick={async () => {
                  const r = await call("wallet");
                  if (r?.client_id && r.request_uri)
                    setOtherDevice(
                      `${boot.origins.wallet}/authorize?${new URLSearchParams({ client_id: r.client_id, request_uri: r.request_uri })}`,
                    );
                }}
              >
                Use a wallet on another device
              </Anchor>
              {otherDevice && (
                <Paper withBorder radius="md" p="sm">
                  <Text size="xs" mb={4}>
                    Open this on the device with your wallet (a QR code, on a real site). When it
                    comes back there, you'll type your email to finish, because that browser hasn't
                    confirmed it's you.
                  </Text>
                  <Code block style={{ wordBreak: "break-all", whiteSpace: "pre-wrap" }}>
                    {otherDevice}
                  </Code>
                </Paper>
              )}
            </Stack>
          </Stepper.Step>
          <Stepper.Completed>
            {v.status === "completed" && v.result ? (
              <Paper withBorder radius="md" p="lg">
                <Group gap="xs" mb="sm">
                  <IconCircleCheck color="teal" />
                  <Text fw={700}>Thank you, your work history is confirmed</Text>
                </Group>
                <Text size="sm" c="dimmed" mb="xs">
                  What we received and keep for this application:
                </Text>
                {v.result.shared.map((s) => (
                  <Group
                    key={s.label}
                    justify="space-between"
                    py={4}
                    style={{ borderBottom: "1px solid #f1f3f5" }}
                  >
                    <Text size="sm">{s.label}</Text>
                    <Text size="sm" fw={600}>
                      {s.value}
                    </Text>
                  </Group>
                ))}
                <Text size="xs" c="dimmed" mt="sm">
                  Your assistant learns only that this step is done.
                </Text>
              </Paper>
            ) : v.status === "expired" ? (
              <Alert color="gray">
                The three days to confirm your work history ran out, so this application expired.
                Your assistant can start a new one.
              </Alert>
            ) : (
              <Alert color="gray">
                You're continuing without a wallet. We'll check your work history another way after
                you apply.
              </Alert>
            )}
            <Button mt="md" component="a" href={`${boot.origins.agent}/`}>
              Return to your assistant
            </Button>
          </Stepper.Completed>
        </Stepper>
      )}
    </Stack>
  );
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const ARRANGEMENT: Record<string, string> = {
  on_site: "on-site",
  hybrid: "hybrid",
  remote: "remote",
};

/** A disclosed location element (RFC 0009) as a recruiter would write it. */
function placeName(x: unknown): string {
  if (!x || typeof x !== "object") return String(x);
  if ("anywhere" in x) return "anywhere";
  const country = "addressCountry" in x ? String(x.addressCountry) : "";
  const region = "addressRegion" in x ? String(x.addressRegion) : "";
  const countryName = country ? (regionNames.of(country) ?? country) : "";
  return [region, countryName].filter(Boolean).join(", ");
}

function describeLearned(r: Received): string[] {
  const l = r.learned;
  const out: string[] = [];
  if (r.occupations.length) out.push(`Open to ${r.occupations.join(", ")} roles`);
  const locations = Array.isArray(l.locations) ? l.locations : [];
  if (locations.length) out.push(`Open to working in ${locations.map(placeName).join(", ")}`);
  const remote = Array.isArray(l.remote_policy) ? l.remote_policy : [];
  if (remote.length)
    out.push(`Open to ${remote.map((r) => ARRANGEMENT[String(r)] ?? String(r)).join(" or ")} work`);
  const salary = Array.isArray(l.salary) ? l.salary[0] : undefined;
  if (salary && typeof salary === "object" && "at_least" in salary)
    out.push(
      `This job's pay works for the candidate (at least $${Number(salary.at_least).toLocaleString()})`,
    );
  if (l.per_employer)
    out.push(`The assistant may apply at most ${String(l.per_employer)} times to Acme`);
  return out;
}

interface KeptRecord {
  organization?: { name?: string };
  current?: boolean;
  tenure_years?: number;
  positionHistories?: Array<{ title?: string }>;
}

function WorkHistory({ r, reload }: { r: Received; reload: () => void }) {
  const w = r.workHistory;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string>();
  if (!w)
    return (
      <Text size="sm" c="dimmed">
        This role doesn't ask for verified work history.
      </Text>
    );
  const requirement = w.requirement && (
    <Text size="xs" c="dimmed">
      Requirement for this role: {w.requirement} A recruiter applies it when reviewing.
    </Text>
  );
  if (w.status === "completed" && w.kept) {
    const record = w.kept.record as KeptRecord;
    return (
      <Stack gap={6}>
        <Badge color="teal" variant="light" leftSection={<IconShieldCheck size={12} />}>
          Verified from the candidate's wallet
        </Badge>
        <Text size="sm">
          {record.positionHistories?.map((p) => p.title).join(" → ")} at {record.organization?.name}
          , {record.tenure_years} years, {record.current ? "still there" : "left"}
        </Text>
        <Text size="xs" c="dimmed">
          Signed by {new URL(w.kept.issuer).host} (
          {w.kept.basis === "customer_records"
            ? "an HR platform reporting its customer's records"
            : "the employer itself"}
          ), and tied to this application.
        </Text>
        {requirement}
      </Stack>
    );
  }
  const record = async (outcome: "confirmed" | "not_confirmed") => {
    setBusy(outcome);
    await api(`/api/ats/${r.applicationId}/check`, { outcome, note });
    setBusy(undefined);
    reload();
  };
  return (
    <Stack gap={8}>
      {w.check ? (
        <Badge
          color={w.check.outcome === "confirmed" ? "teal" : "orange"}
          variant="light"
          leftSection={<IconClipboardCheck size={12} />}
        >
          {w.check.outcome === "confirmed"
            ? "Checked by a recruiter"
            : "Recruiter couldn't confirm"}
        </Badge>
      ) : (
        <Badge color="yellow" variant="light" leftSection={<IconAlertTriangle size={12} />}>
          To check: the candidate didn't use a wallet
        </Badge>
      )}
      <Text size="sm">
        {w.check
          ? "The candidate chose to continue without a wallet, and a recruiter checked the work history by other means."
          : "The candidate chose to continue without a wallet, so nothing here is verified yet. Check the work history your usual way, such as a reference call or a verification service."}
      </Text>
      {requirement}
      <Text size="xs" c="dimmed">
        RFC 0013 §7: an application can't be ranked, filtered or delayed because of which route the
        candidate took. Review it like any other.
      </Text>
      {w.check ? (
        <Text size="xs" c="dimmed">
          Recorded {new Date(w.check.at * 1000).toLocaleString()}
          {w.check.note ? `: ${w.check.note}` : "."}
        </Text>
      ) : (
        <Stack gap={6}>
          <TextInput
            size="xs"
            placeholder="How you checked (e.g. called the former manager)"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <Group gap="xs">
            <Button size="xs" loading={busy === "confirmed"} onClick={() => record("confirmed")}>
              Work history confirmed
            </Button>
            <Button
              size="xs"
              variant="default"
              loading={busy === "not_confirmed"}
              onClick={() => record("not_confirmed")}
            >
              Couldn't confirm
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}

function Ats() {
  const [rows, setRows] = useState<Received[]>();
  const reload = useCallback(() => {
    void api<{ received: Received[] }>("/api/ats").then((r) => setRows(r.received));
  }, []);
  useEffect(() => {
    reload();
    void api("/_sandbox/visit", { page: "ats" });
  }, [reload]);
  if (!rows) return <Loader />;
  const toCheck = rows.filter((r) => r.workHistory?.status === "deferred" && !r.workHistory.check);
  return (
    <Stack gap="lg">
      <Box>
        <Title order={2}>Applications</Title>
        <Text c="dimmed">
          What Acme's recruiters see. {rows.length} received
          {toCheck.length ? `, ${toCheck.length} with work history to check` : ""}.
        </Text>
      </Box>
      {rows.length === 0 && <Text c="dimmed">No applications yet.</Text>}
      {rows.map((r) => (
        <Paper key={r.applicationId} withBorder radius="md" p="lg">
          <Group justify="space-between" align="flex-start">
            <Box>
              <Text fw={700} size="lg">
                {r.contact ?? "Candidate"}
              </Text>
              <Text size="sm" c="dimmed">
                {r.job.title} · received {new Date(r.at * 1000).toLocaleString()}
              </Text>
            </Box>
            <Badge
              color={r.mandate === "standing" ? "violet" : "blue"}
              variant="light"
              leftSection={<IconRobot size={12} />}
            >
              {r.mandate === "standing"
                ? "Sent by an AI assistant, with the candidate's permission"
                : "Approved by the candidate on their device"}
            </Badge>
          </Group>
          <SimpleGrid cols={{ base: 1, md: 2 }} mt="md">
            <Box>
              <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={4}>
                The permission told us
              </Text>
              <List size="sm" spacing={2}>
                {describeLearned(r).map((x) => (
                  <List.Item key={x}>{x}</List.Item>
                ))}
              </List>
            </Box>
            <Box>
              <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={4}>
                Work history
              </Text>
              <WorkHistory r={r} reload={reload} />
            </Box>
          </SimpleGrid>
          <Group gap={6} mt="md" align="flex-start" wrap="nowrap">
            <IconEyeOff size={16} color="gray" style={{ marginTop: 2 }} />
            <Text size="xs" c="dimmed">
              Never received: the candidate's actual pay floor, the other jobs and places they'd
              accept, where else they applied, exact employment dates, and anything in their wallet
              we didn't ask for.
            </Text>
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}

export function Employer() {
  const [site, setSite] = useState<Site>();
  useEffect(() => {
    api<Site>("/api/site").then(setSite);
  }, []);
  const path = location.pathname;
  const verify = path.match(/^\/verify\/([A-Z0-9]{4,6})$/)?.[1];
  const tab = verify ? "verify" : path === "/ats" && isAcme ? "ats" : "jobs";
  return (
    <Box bg="#f7f7f8" mih="calc(100vh - var(--bar-h, 116px))">
      <Header site={site} tab={tab} />
      <Container size="lg" py="xl">
        {tab === "verify" && verify ? (
          <Verify appRef={verify} />
        ) : tab === "ats" ? (
          <Ats />
        ) : site ? (
          <Jobs site={site} />
        ) : (
          <Loader />
        )}
        {tab === "jobs" && !isAcme && (
          <Text size="xs" c="dimmed" mt="xl">
            A job site in the OJCP sandbox.{" "}
            <Anchor href={`${boot.origins.home}/hood`}>
              Who runs it, and does the assistant trust it?
            </Anchor>
          </Text>
        )}
      </Container>
    </Box>
  );
}
