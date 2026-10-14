/**
 * Tab 2: Jordan's wallet, on his phone. It collects records from issuers and
 * shows employers only what they ask for, after checking who is asking.
 */
import {
  Alert,
  Anchor,
  Avatar,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Divider,
  Group,
  List,
  Loader,
  Modal,
  NumberInput,
  Paper,
  PinInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconEyeOff,
  IconFaceId,
  IconLock,
  IconShieldCheck,
  IconX,
} from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { api, boot } from "../boot.ts";

interface WalletRecord {
  id: string;
  type: string;
  issuer: { origin: string; name: string };
  basis: string;
  holderName?: string;
  record: {
    organization?: { name?: string };
    current?: boolean;
    start?: string;
    tenure_years?: number;
    positionHistories?: Array<{ title?: string }>;
  };
  addedAt: number;
  expiresAt: number;
  copies: number;
}

interface Summary {
  records: WalletRecord[];
  activity: Array<{ at: number; kind: string; text: string }>;
}

interface Preview {
  issuer: { origin: string; name: string };
  types: string[];
  txCode?: { length: number; description: string };
}

interface Consent {
  id: string;
  verifier: { host: string; organization: string };
  application?: {
    application_ref: string;
    masked_contact: string;
    purpose: string;
    employer: string;
    job_title: string;
  };
  share: Array<{ label: string; value: string }>;
  withheld: string[];
  warnings: string[];
  hasRecord: boolean;
}

const day = (s: number) =>
  new Date(s * 1000).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });

function Phone({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Center py="xl" bg="#e9ecf3" mih="calc(100vh - var(--bar-h, 116px))">
      <div className="phone-device">
        <div className="phone-screen">
          <Box bg="#0b0d12" c="white" px="lg" pt="lg" pb="md">
            <Text size="xs" c="gray.5">
              Wallet
            </Text>
            <Title order={3} c="white">
              {title}
            </Title>
          </Box>
          <Stack p="md" gap="md" className="phone-scroll">
            {children}
          </Stack>
        </div>
      </div>
    </Center>
  );
}

function RecordCard({ r }: { r: WalletRecord }) {
  const titles = r.record.positionHistories?.map((p) => p.title).filter(Boolean) ?? [];
  return (
    <div className="record-card">
      <Text size="xs" tt="uppercase" fw={600} style={{ opacity: 0.8, letterSpacing: "0.06em" }}>
        {r.type}
      </Text>
      <Text fw={700} size="xl" mt={4}>
        {r.record.organization?.name}
      </Text>
      <Text size="sm" style={{ opacity: 0.92 }}>
        {titles.at(-1)} · {r.record.current ? "current" : "former"} · {r.record.tenure_years ?? 0}{" "}
        years
      </Text>
      <Group justify="space-between" mt="md">
        <Text size="xs" style={{ opacity: 0.8 }}>
          Issued by {r.issuer.name}
        </Text>
        <Text size="xs" style={{ opacity: 0.8 }}>
          Valid until {day(r.expiresAt)}
        </Text>
      </Group>
    </div>
  );
}

interface Permission {
  id: string;
  agent: string;
  agentId: string;
  approvedAt: string;
  until: string;
  jobs: string[];
  perEmployer: number;
  total: number;
}

/** An agent_id is its platform's domain, reversed (spec *Agent Identity*). */
const domainOf = (agentId: string) => agentId.split(".").reverse().join(".");

function Records() {
  const [s, setS] = useState<Summary>();
  useEffect(() => {
    api<Summary>("/api/wallet").then(setS);
  }, []);
  if (!s) return <Loader m="auto" />;
  const added = new URLSearchParams(location.search).has("added");
  return (
    <>
      {added && (
        <Alert color="teal" icon={<IconCircleCheck />}>
          Saved. The issuer's signature checked out.
        </Alert>
      )}
      {s.records.length === 0 ? (
        <Paper p="lg" radius="lg" withBorder>
          <Text fw={600}>No records yet</Text>
          <Text size="sm" c="dimmed" mb="md">
            Your employer's HR site can add a signed record of your job.
          </Text>
          <Button component="a" href={`${boot.origins.hr}/`} variant="light">
            Open ExamplePeople
          </Button>
        </Paper>
      ) : (
        s.records.map((r) => <RecordCard key={r.id} r={r} />)
      )}
      {s.activity.length > 0 && (
        <Paper p="md" radius="lg" withBorder>
          <Text fw={600} mb="xs">
            Activity
          </Text>
          <Stack gap={8}>
            {s.activity.map((a) => (
              <Box key={`${a.at}-${a.text}`}>
                <Text size="sm">{a.text}</Text>
                <Text size="xs" c="dimmed">
                  {day(a.at)}
                </Text>
              </Box>
            ))}
          </Stack>
        </Paper>
      )}
    </>
  );
}

function Permissions() {
  const [list, setList] = useState<Permission[]>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const load = useCallback(() => api<Permission[]>("/api/wallet/permissions").then(setList), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!list) return <Loader m="auto" />;
  return (
    <>
      <Text size="sm" c="dimmed">
        Assistants you've let apply for jobs for you. Your wallet provider keeps these approvals; an
        assistant can't change them.
      </Text>
      {note && (
        <Alert color="teal" icon={<IconCircleCheck />}>
          {note}
        </Alert>
      )}
      {list.length === 0 && (
        <Paper p="lg" radius="lg" withBorder>
          <Text size="sm" c="dimmed">
            No assistant has permission to act for you.
          </Text>
        </Paper>
      )}
      {list.map((p) => (
        <Paper key={p.id} p="md" radius="lg" withBorder>
          <Group gap="sm" wrap="nowrap" mb="xs">
            <Avatar color="dark" radius="xl">
              {p.agent.slice(0, 1)}
            </Avatar>
            <Box>
              <Text fw={700}>{p.agent}</Text>
              <Text size="xs" c="dimmed">
                {domainOf(p.agentId)} · approved {p.approvedAt}
              </Text>
            </Box>
          </Group>
          <Text size="sm">
            Can apply for {p.jobs.join(", ")} roles, at most {p.perEmployer} per company and{" "}
            {p.total} in total, until {p.until}.
          </Text>
          <Button
            mt="sm"
            size="xs"
            color="red"
            variant="light"
            loading={busy === p.id}
            onClick={async () => {
              if (!confirm(`Cancel ${p.agent}'s permission?`)) return;
              setBusy(p.id);
              await api(`/api/wallet/permissions/${p.id}/cancel`, {});
              setNote(
                `Cancelled. ${p.agent} and employers stop accepting it when the permission service next publishes its status lists, within about two hours.`,
              );
              setBusy(undefined);
              await load();
            }}
          >
            Cancel permission
          </Button>
        </Paper>
      ))}
    </>
  );
}

function Home() {
  const [view, setView] = useState(location.hash === "#permissions" ? "permissions" : "records");
  return (
    <>
      <SegmentedControl
        fullWidth
        radius="xl"
        value={view}
        onChange={(v) => {
          setView(v);
          history.replaceState(null, "", v === "permissions" ? "#permissions" : "#");
        }}
        data={[
          { value: "records", label: "Records" },
          { value: "permissions", label: "Permissions" },
        ]}
      />
      {view === "permissions" ? <Permissions /> : <Records />}
    </>
  );
}

interface ConsentView {
  id: string;
  client: { name: string; agentId: string; affiliated: boolean };
  until: string;
  jobs: Option[];
  places: Option[];
  arrangements: Option[];
  pay: string;
  perEmployer: number;
  total: number;
  actions: Option[];
  recipients: string;
  shared: string;
  never: string[];
  ending: string;
  contacts: Option[];
}

interface Option {
  value: string;
  label: string;
  hint?: string;
}

/**
 * The permission service's consent screen (RFC 0008 §3.3). Jordan's wallet
 * provider runs the service, so this is a wallet screen: the wallet already
 * verified his email when he set it up, and he approves with Face ID. He can
 * only narrow what the assistant asked for.
 */
function Consent() {
  const id = location.pathname.split("/").at(-1) ?? "";
  const [v, setV] = useState<ConsentView>();
  const [error, setError] = useState<string>();
  const [jobs, setJobs] = useState<string[]>([]);
  const [places, setPlaces] = useState<string[]>([]);
  const [arrangements, setArrangements] = useState<string[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [perEmployer, setPerEmployer] = useState(1);
  const [total, setTotal] = useState(1);
  const [busy, setBusy] = useState<string>();
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    api<ConsentView>(`/api/wallet/consent/${id}`).then(
      (c) => {
        setV(c);
        setJobs(c.jobs.map((o) => o.value));
        setPlaces(c.places.map((o) => o.value));
        setArrangements(c.arrangements.map((o) => o.value));
        setActions(c.actions.map((o) => o.value));
        setPerEmployer(c.perEmployer);
        setTotal(c.total);
      },
      (e: Error) => setError(e.message),
    );
  }, [id]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  }

  if (!v) return error ? <Alert color="red">{error}</Alert> : <Loader m="auto" />;
  const group = (label: string, options: Option[], value: string[], set: (v: string[]) => void) => (
    <Checkbox.Group label={label} value={value} onChange={set}>
      <Stack gap={6} mt={6}>
        {options.map((o) => (
          <Checkbox key={o.value} value={o.value} label={o.label} description={o.hint} />
        ))}
      </Stack>
    </Checkbox.Group>
  );
  const nothingLeft = jobs.length === 0 || places.length === 0 || arrangements.length === 0;

  return (
    <>
      <Paper p="md" radius="lg" withBorder>
        <Group gap="sm" wrap="nowrap">
          <Avatar color="dark" radius="xl">
            {v.client.name.slice(0, 1)}
          </Avatar>
          <Box style={{ minWidth: 0 }}>
            <Text fw={700}>{v.client.name}</Text>
            <Text size="xs" c="dimmed">
              {domainOf(v.client.agentId)}
            </Text>
          </Box>
        </Group>
        <Text size="sm" mt="sm">
          wants permission to apply for jobs for you until <b>{v.until}</b>. Untick anything you
          don't want, and lower any limit.
        </Text>
        <Text size="xs" c="dimmed" mt={6}>
          {v.client.affiliated
            ? `${v.client.name} is run by your wallet provider.`
            : `${v.client.name} is a separate company. It can't approve this for you or change it later.`}
        </Text>
      </Paper>
      <Paper p="md" radius="lg" withBorder>
        <Stack gap="md">
          {group("Kinds of job", v.jobs, jobs, setJobs)}
          {group("Where", v.places, places, setPlaces)}
          {group("How", v.arrangements, arrangements, setArrangements)}
          <Box>
            <Text size="sm" fw={500}>
              Pay
            </Text>
            <Text size="sm">{v.pay}</Text>
            <Text size="xs" c="dimmed">
              Employers never see this number, only that a job's own pay works for you.
            </Text>
          </Box>
        </Stack>
      </Paper>
      <Paper p="md" radius="lg" withBorder>
        <Stack gap="sm">
          <Group grow>
            <Select
              label="Per company"
              value={String(perEmployer)}
              onChange={(x) => setPerEmployer(Number(x))}
              data={[1, 2, 3].filter((n) => n <= v.perEmployer).map(String)}
              allowDeselect={false}
            />
            <NumberInput
              label="In total"
              min={1}
              max={v.total}
              value={total}
              onChange={(x) => setTotal(Number(x) || 1)}
            />
          </Group>
          {group("What it may do", v.actions, actions, setActions)}
        </Stack>
      </Paper>
      <Paper p="md" radius="lg" withBorder>
        <Text size="sm" fw={500}>
          Who gets your applications
        </Text>
        <Text size="sm">{v.recipients}</Text>
        <Text size="sm" mt={4}>
          {v.shared}
        </Text>
        <Text size="sm" fw={500} mt="sm">
          Never, under this permission
        </Text>
        <List
          size="sm"
          spacing={2}
          icon={
            <ThemeIcon size={18} radius="xl" color="red" variant="light">
              <IconX size={11} />
            </ThemeIcon>
          }
        >
          {v.never.map((n) => (
            <List.Item key={n}>{n}</List.Item>
          ))}
        </List>
        <Text size="xs" c="dimmed" mt="sm">
          {v.ending} You can cancel in your wallet under Permissions.
        </Text>
      </Paper>
      {error && <Alert color="red">{error}</Alert>}
      <Stack gap="xs">
        <Button
          size="md"
          leftSection={<IconFaceId size={20} />}
          disabled={nothingLeft}
          loading={busy === "approve"}
          onClick={() =>
            run("approve", async () => {
              // The sandbox's stand-in for the phone's biometric prompt.
              setScanning(true);
              await new Promise((r) => setTimeout(r, 900));
              setScanning(false);
              const { redirect } = await api<{ redirect: string }>(
                `/api/wallet/consent/${id}/approve`,
                {
                  selection: {
                    job_families: jobs,
                    locations: places,
                    remote_policy: arrangements,
                    actions,
                    per_employer: perEmployer,
                    applications_total: total,
                  },
                },
              );
              location.href = redirect;
            })
          }
        >
          Approve with Face ID
        </Button>
        {nothingLeft && (
          <Text size="xs" c="dimmed" ta="center">
            Keep at least one kind of job, place and way of working, or decline.
          </Text>
        )}
        <Button
          size="md"
          variant="subtle"
          loading={busy === "deny"}
          onClick={() =>
            run("deny", async () => {
              const { redirect } = await api<{ redirect: string }>(
                `/api/wallet/consent/${id}/decline`,
                {},
              );
              location.href = redirect;
            })
          }
        >
          Decline
        </Button>
      </Stack>
      <Modal
        opened={scanning}
        onClose={() => undefined}
        withCloseButton={false}
        centered
        size="xs"
        radius="lg"
        title="Face ID"
      >
        <Stack align="center" gap="xs" py="md">
          <IconFaceId size={56} stroke={1.2} />
          <Text size="sm">Confirming it's you…</Text>
        </Stack>
      </Modal>
      <Text size="xs" c="dimmed" ta="center">
        Your wallet provider keeps this permission, not {v.client.name}. Cancel it any time under
        Permissions.
      </Text>
    </>
  );
}

function Offer() {
  const offer = `?${location.search.slice(1)}`;
  const [p, setP] = useState<Preview>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    api<Preview>("/api/wallet/offer/preview", { offer }).then(setP, (e: Error) =>
      setError(e.message),
    );
  }, [offer]);

  async function accept() {
    setBusy(true);
    setError(undefined);
    try {
      await api("/api/wallet/offer/accept", { offer, tx_code: code });
      location.href = "/?added=1";
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (error && !p) return <Alert color="red">{error}</Alert>;
  if (!p) return <Loader m="auto" />;
  return (
    <>
      <Paper p="lg" radius="lg" withBorder>
        <Text size="sm" c="dimmed">
          {p.issuer.name} wants to add
        </Text>
        <Text fw={700} size="xl">
          {p.types.join(", ")}
        </Text>
        <Text size="xs" c="dimmed" mt={4}>
          from {new URL(p.issuer.origin).host}
        </Text>
      </Paper>
      {p.txCode && (
        <Paper p="lg" radius="lg" withBorder>
          <Text fw={600} mb={4}>
            Enter the code we texted you
          </Text>
          <Text size="xs" c="dimmed" mb="sm">
            In the sandbox, texts arrive in Jordan's inbox at the top of the page.
          </Text>
          <PinInput length={p.txCode.length} type="number" value={code} onChange={setCode} />
        </Paper>
      )}
      <Text size="sm" c="dimmed">
        Your wallet checks the record against {p.issuer.name}'s published key before saving it.
      </Text>
      {error && <Alert color="red">{error}</Alert>}
      <Box style={{ flex: 1 }} />
      <Stack gap="xs">
        <Button
          size="md"
          loading={busy}
          onClick={accept}
          disabled={p.txCode !== undefined && code.length < p.txCode.length}
        >
          Add to wallet
        </Button>
        <Button size="md" variant="subtle" component="a" href="/">
          Not now
        </Button>
      </Stack>
    </>
  );
}

function Authorize() {
  const params = new URLSearchParams(location.search);
  const clientId = params.get("client_id") ?? "";
  const requestUri = params.get("request_uri") ?? "";
  const [c, setC] = useState<Consent>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"share" | "decline">();
  // Fetched once per link: the request URI allows only a few fetches.
  useEffect(() => {
    api<Consent>("/api/wallet/request/open", {
      client_id: clientId,
      request_uri: requestUri,
    }).then(setC, (e: Error) => setError(e.message));
  }, [clientId, requestUri]);

  async function respond(decision: "share" | "decline") {
    if (!c) return;
    setBusy(decision);
    try {
      const { redirect_uri } = await api<{ redirect_uri?: string }>(`/api/wallet/request/${c.id}`, {
        decision,
      });
      location.href = redirect_uri ?? "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(undefined);
    }
  }

  if (error && !c)
    return (
      <Alert color="red" icon={<IconAlertTriangle />} title="Request not shown">
        {error}
      </Alert>
    );
  if (!c) return <Loader m="auto" />;
  const who = c.application?.employer ?? c.verifier.organization;
  return (
    <>
      <Paper p="md" radius="lg" withBorder>
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon color="teal" radius="xl" size={36}>
            <IconShieldCheck size={20} />
          </ThemeIcon>
          <Box>
            <Text fw={700}>{c.verifier.organization}</Text>
            <Text size="xs" c="dimmed">
              {c.verifier.host} · verified by a certificate authority your wallet trusts
            </Text>
          </Box>
        </Group>
        {c.application && (
          <Group mt="sm" gap="xs">
            <Badge variant="light" color="gray">
              {c.application.job_title}
            </Badge>
            <Badge variant="outline" color="gray" ff="monospace">
              {c.application.application_ref}
            </Badge>
            <Badge variant="outline" color="gray">
              {c.application.masked_contact}
            </Badge>
          </Group>
        )}
      </Paper>
      {c.application && (
        <Box>
          <Text size="xs" c="dimmed" mb={2}>
            {who}'s statement
          </Text>
          <Text size="sm" fs="italic">
            "{c.application.purpose}"
          </Text>
        </Box>
      )}
      {c.warnings.length > 0 && (
        <Alert color="red" icon={<IconAlertTriangle />} title="Asks for more than employers may">
          {c.warnings.join(", ")}
        </Alert>
      )}
      {c.hasRecord ? (
        <Paper p="md" radius="lg" withBorder>
          <Text fw={600} mb={4}>
            {who} will see
          </Text>
          {c.share.map((s) => (
            <Group
              key={s.label}
              justify="space-between"
              py={6}
              style={{ borderBottom: "1px solid #eef0f3" }}
              wrap="nowrap"
            >
              <Text size="sm">{s.label}</Text>
              <Text size="sm" fw={600} ta="right">
                {s.value}
              </Text>
            </Group>
          ))}
          {c.withheld.length > 0 && (
            <>
              <Divider my="sm" />
              <Group gap={6} align="flex-start" wrap="nowrap">
                <IconEyeOff size={16} color="gray" style={{ marginTop: 2 }} />
                <Text size="xs" c="dimmed">
                  Not shared: {c.withheld.join(", ").toLowerCase()}, and anything else in your
                  wallet.
                </Text>
              </Group>
            </>
          )}
        </Paper>
      ) : (
        <Alert color="yellow">You don't have a record {who} accepts.</Alert>
      )}
      <Group gap={6} wrap="nowrap">
        <IconLock size={14} color="gray" />
        <Text size="xs" c="dimmed">
          Sent encrypted, straight to {c.verifier.host}. Your assistant never sees it.
        </Text>
      </Group>
      {error && <Alert color="red">{error}</Alert>}
      <Box style={{ flex: 1 }} />
      <Stack gap="xs">
        <Button
          size="md"
          disabled={!c.hasRecord}
          loading={busy === "share"}
          onClick={() => respond("share")}
        >
          Share with {who}
        </Button>
        <Button
          size="md"
          variant="subtle"
          loading={busy === "decline"}
          onClick={() => respond("decline")}
        >
          Don't share
        </Button>
      </Stack>
    </>
  );
}

export function Wallet() {
  const path = location.pathname;
  if (path.startsWith("/permissions/"))
    return (
      <Phone title="Approve a permission">
        <Consent />
      </Phone>
    );
  if (path === "/offer")
    return (
      <Phone title="Add a record">
        <Offer />
      </Phone>
    );
  if (path === "/authorize")
    return (
      <Phone title="Share a record?">
        <Authorize />
      </Phone>
    );
  return (
    <Phone title="Your wallet">
      <Home />
      <Anchor href={`${boot.origins.home}/`} size="xs" c="dimmed" ta="center">
        How the wallet decides what to trust
      </Anchor>
    </Phone>
  );
}
