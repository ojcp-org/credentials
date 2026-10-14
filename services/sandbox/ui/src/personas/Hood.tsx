/**
 * Tab 5: under the hood, in OJCP's own look. The story so far, who's who, every
 * message between the parties, and a lab for what happens when things go wrong.
 */
import {
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  Container,
  Grid,
  Group,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { IconCheck, IconExternalLink } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { api, boot } from "../boot.ts";
import { useStory } from "../chrome/SandboxBar.tsx";
import { OJCP } from "../theme.ts";

interface Party {
  host: string;
  origin: string;
  name: string;
  role: string;
  tier?: string;
}

interface Parties {
  parties: Party[];
  clock: { now: number; offset: number };
  probes: Array<{ id: string; title: string; rfc: string; expected: string }>;
}

interface Event {
  id: number;
  at: number;
  actor: string;
  where: string;
  title: string;
  outcome: "ok" | "refused" | "info";
  detail?: Record<string, unknown>;
}

const ACTOR_COLOR: Record<string, string> = {
  hr: "teal",
  wallet: "indigo",
  agent: "blue",
  issuer: "violet",
  provider: "orange",
  attester: "green",
  lists: "green",
  candidate: "pink",
  sandbox: "gray",
};

const TIER_COLOR: Record<string, string> = { verified: "teal", audited: "teal", unverified: "red" };

function Section({
  title,
  kicker,
  children,
}: {
  title: string;
  kicker: string;
  children: React.ReactNode;
}) {
  return (
    <Box mb={48}>
      <Text
        c={OJCP.gold}
        size="xs"
        fw={700}
        tt="uppercase"
        mb={4}
        style={{ letterSpacing: "0.1em" }}
      >
        {kicker}
      </Text>
      <Title order={2} mb="md" c={OJCP.text}>
        {title}
      </Title>
      {children}
    </Box>
  );
}

function Timeline() {
  const [events, setEvents] = useState<Event[]>([]);
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState<number>();
  useEffect(() => {
    let since = 0;
    let live = true;
    const load = async () => {
      const fresh = await api<Event[]>(`/_sandbox/events?since=${since}`).catch(() => []);
      if (!live || fresh.length === 0) return;
      since = Math.max(since, ...fresh.map((e) => e.id));
      setEvents((prev) => [...fresh.reverse(), ...prev].slice(0, 500));
    };
    void load();
    const t = setInterval(load, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  const shown = events.filter((e) => filter === "all" || e.actor === filter);
  return (
    <Paper bg={OJCP.surface} p="md" radius="md" style={{ border: "1px solid #28282f" }}>
      <SegmentedControl
        size="xs"
        mb="md"
        value={filter}
        onChange={setFilter}
        data={[
          { value: "all", label: "Everyone" },
          { value: "hr", label: "HR" },
          { value: "wallet", label: "Wallet" },
          { value: "agent", label: "Assistant" },
          { value: "issuer", label: "Permission" },
          { value: "provider", label: "Employers" },
          { value: "candidate", label: "Jordan" },
        ]}
      />
      <ScrollArea h={520}>
        <Stack gap={6}>
          {shown.map((e) => (
            <Box
              key={e.id}
              pl="sm"
              py={4}
              style={{
                borderLeft: `3px solid ${e.outcome === "ok" ? "#2b8a3e" : e.outcome === "refused" ? "#e03131" : "#3a3a46"}`,
                cursor: e.detail ? "pointer" : undefined,
              }}
              onClick={() => setOpen(open === e.id ? undefined : e.id)}
            >
              <Group gap={6}>
                <Badge size="xs" color={ACTOR_COLOR[e.actor] ?? "gray"} variant="light">
                  {e.actor}
                </Badge>
                <Text size="xs" c={OJCP.muted}>
                  {e.where} · {new Date(e.at * 1000).toISOString().slice(11, 19)}
                </Text>
              </Group>
              <Text size="sm" c={OJCP.text}>
                {e.title}
              </Text>
              {open === e.id && e.detail && (
                <Code block mt={6} style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>
                  {JSON.stringify(e.detail, null, 2)}
                </Code>
              )}
            </Box>
          ))}
          {shown.length === 0 && <Text c={OJCP.muted}>Nothing yet.</Text>}
        </Stack>
      </ScrollArea>
    </Paper>
  );
}

function Lab({ parties, reload }: { parties: Parties; reload: () => void }) {
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();
  const [provider, setProvider] = useState<string | null>("acme");
  const [url, setUrl] = useState(boot.origins.acme ?? "");
  const [results, setResults] =
    useState<
      Array<{
        title: string;
        rfc: string;
        expected: string;
        got: string;
        pass: boolean | "skipped";
      }>
    >();
  const run = async (key: string, path: string, body: unknown = {}, done?: string) => {
    setBusy(key);
    setNote(undefined);
    try {
      const r = await api<unknown>(path, body);
      setNote(done ?? "Done. See the timeline.");
      reload();
      return r;
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };
  const btn = (key: string, label: string, path: string, body?: unknown, done?: string) => (
    <Button
      key={key}
      size="xs"
      variant="default"
      loading={busy === key}
      onClick={() => run(key, path, body, done)}
    >
      {label}
    </Button>
  );
  return (
    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
      <Paper bg={OJCP.surface} p="lg" radius="md" style={{ border: "1px solid #28282f" }}>
        <Text fw={700} c={OJCP.text}>
          Things that go wrong
        </Text>
        <Text size="sm" c={OJCP.muted} mb="md">
          Each changes the world; go back to the assistant to see how it reacts.
        </Text>
        <Stack gap="xs" align="flex-start">
          {btn(
            "takeover",
            "Acme's domain changes hands (new identity key)",
            "/_sandbox/lab/incident/takeover",
          )}
          {btn("suspend", "The registry suspends ExampleATS", "/_sandbox/lab/incident/suspend")}
          {btn(
            "distrust",
            "The trust list drops Sandbox KYB Co.",
            "/_sandbox/lab/incident/distrust",
          )}
          {btn(
            "cancel",
            "Jordan cancels the assistant's permission",
            "/_sandbox/lab/incident/cancel",
          )}
          {btn("clear", "Clear incidents", "/_sandbox/lab/incident/clear")}
        </Stack>
        <Text fw={700} c={OJCP.text} mt="lg">
          Time
        </Text>
        <Text size="sm" c={OJCP.muted} mb="xs">
          Sandbox time: {new Date(parties.clock.now * 1000).toUTCString().slice(0, 22)}
          {parties.clock.offset ? ` (${Math.round(parties.clock.offset / 3600)} h ahead)` : ""}
        </Text>
        <Group gap="xs">
          {btn("2h", "+2 hours", "/_sandbox/lab/clock", { seconds: 7200 })}
          {btn("1d", "+1 day", "/_sandbox/lab/clock", { seconds: 86_400 })}
          {btn("62d", "+62 days", "/_sandbox/lab/clock", { seconds: 5_356_800 })}
        </Group>
        <Group mt="lg" gap="xs">
          <Button
            size="xs"
            color="red"
            variant="light"
            loading={busy === "reset"}
            onClick={() => {
              if (confirm("Rebuild the sandbox with new keys? Everything starts over."))
                void run("reset", "/_sandbox/lab/reset", {}, "Reset. Start again at the HR tab.");
            }}
          >
            Reset the whole sandbox
          </Button>
        </Group>
        {note && (
          <Text size="sm" c={OJCP.gold} mt="md">
            {note}
          </Text>
        )}
      </Paper>
      <Paper bg={OJCP.surface} p="lg" radius="md" style={{ border: "1px solid #28282f" }}>
        <Text fw={700} c={OJCP.text}>
          A hostile assistant tries…
        </Text>
        <Text size="sm" c={OJCP.muted} mb="sm">
          Crafted requests over the wire; the employer's system must refuse each one.
        </Text>
        <Select
          size="xs"
          mb="sm"
          value={provider}
          onChange={setProvider}
          data={[
            { value: "acme", label: "Acme" },
            { value: "ats", label: "ExampleATS" },
            { value: "globex", label: "Globex (tenant)" },
          ]}
        />
        <Group gap={6}>
          {parties.probes.map((p) => (
            <Button
              key={p.id}
              size="compact-xs"
              variant="default"
              title={`${p.rfc}. Expect: ${p.expected}`}
              loading={busy === p.id}
              onClick={() => run(p.id, "/_sandbox/lab/probe", { provider, case: p.id })}
            >
              {p.title}
            </Button>
          ))}
        </Group>
        <Text fw={700} c={OJCP.text} mt="lg">
          Conformance run
        </Text>
        <Text size="sm" c={OJCP.muted} mb="xs">
          Every case against any provider that admits the sandbox's permission service.
        </Text>
        <Group gap="xs">
          <TextInput
            size="xs"
            style={{ flex: 1 }}
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
          />
          <Button
            size="xs"
            color="ojcpGold"
            c={OJCP.obsidian}
            loading={busy === "conf"}
            onClick={async () => {
              const r = await run("conf", "/_sandbox/lab/conformance", { provider: url });
              if (r && typeof r === "object" && "results" in r)
                setResults(r.results as typeof results);
            }}
          >
            Run
          </Button>
        </Group>
        {results && (
          <Stack gap={4} mt="sm">
            {results.map((r) => (
              <Group key={r.title} gap={6} wrap="nowrap" align="flex-start">
                <Badge
                  size="xs"
                  miw={44}
                  style={{ flexShrink: 0 }}
                  color={r.pass === true ? "teal" : r.pass === false ? "red" : "gray"}
                >
                  {r.pass === true ? "pass" : r.pass === false ? "fail" : "skip"}
                </Badge>
                <Text size="xs" c={OJCP.text}>
                  {r.title}{" "}
                  <span style={{ color: OJCP.muted }}>
                    ({r.rfc}: got {r.got})
                  </span>
                </Text>
              </Group>
            ))}
          </Stack>
        )}
      </Paper>
    </SimpleGrid>
  );
}

export function Hood() {
  const story = useStory();
  const [parties, setParties] = useState<Parties>();
  const reload = useCallback(() => {
    void api<Parties>("/_sandbox/parties").then(setParties);
  }, []);
  useEffect(() => {
    reload();
    void api("/_sandbox/visit", { page: "hood" });
  }, [reload]);

  return (
    <Box bg={OJCP.obsidian} mih="calc(100vh - var(--bar-h, 116px))" c={OJCP.text}>
      <Container size="xl" py={48}>
        <Box mb={48} maw={760}>
          <Title order={1} mb="sm" c={OJCP.text}>
            Under the hood
          </Title>
          <Text c={OJCP.muted}>
            Every party in this story runs on its own origin and talks to the others over HTTPS, the
            way separate companies would. The HR platform signs Jordan's record; his wallet shows it
            only to the employer that asks; his assistant applies under a permission it can't
            stretch, and never sees the record. Here's how each step works, and what happens when
            something goes wrong.
          </Text>
        </Box>

        <Grid gutter={48}>
          <Grid.Col span={{ base: 12, md: 5 }}>
            <Section kicker="The story" title="Ten steps">
              <Stack gap="sm">
                {story?.steps.map((s) => (
                  <Group key={s.n} gap="sm" wrap="nowrap" align="flex-start">
                    <ThemeIcon
                      size={26}
                      radius="xl"
                      color={s.done ? "teal" : s.n === story.current ? "ojcpGold" : "dark"}
                      variant={s.done || s.n === story.current ? "filled" : "light"}
                    >
                      {s.done ? <IconCheck size={14} /> : <Text size="xs">{s.n}</Text>}
                    </ThemeIcon>
                    <Box>
                      <Anchor href={s.href} c={OJCP.text} fw={600} size="sm">
                        {s.title}
                      </Anchor>
                      <Text size="xs" c={OJCP.muted}>
                        {s.detail}
                      </Text>
                    </Box>
                  </Group>
                ))}
              </Stack>
            </Section>
            <Section kicker="Who's who" title="The parties">
              <Stack gap="xs">
                {parties?.parties.map((p) => (
                  <Paper
                    key={p.host}
                    bg={OJCP.surface}
                    p="sm"
                    radius="md"
                    style={{ border: "1px solid #28282f" }}
                  >
                    <Group justify="space-between" wrap="nowrap">
                      <Box style={{ minWidth: 0 }}>
                        <Text size="sm" fw={600} c={OJCP.text}>
                          {p.name}
                        </Text>
                        <Text size="xs" c={OJCP.muted}>
                          {p.role}
                        </Text>
                      </Box>
                      <Group gap={6} wrap="nowrap">
                        {p.tier && (
                          <Badge size="sm" color={TIER_COLOR[p.tier] ?? "gray"} variant="light">
                            {p.tier}
                          </Badge>
                        )}
                        <Anchor href={`${p.origin}/`} c={OJCP.muted} title={p.origin}>
                          <IconExternalLink size={15} />
                        </Anchor>
                      </Group>
                    </Group>
                  </Paper>
                ))}
              </Stack>
            </Section>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 7 }}>
            <Section kicker="Behind the scenes" title="Every message, as it happened">
              <Timeline />
            </Section>
          </Grid.Col>
        </Grid>
        <Section kicker="Lab" title="What could go wrong">
          {parties && <Lab parties={parties} reload={reload} />}
        </Section>
      </Container>
    </Box>
  );
}
