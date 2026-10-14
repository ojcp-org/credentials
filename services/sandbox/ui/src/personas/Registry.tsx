/**
 * The attesters' and the trust-list publisher's own sites (RFC 0010). Each
 * shows, in plain words, who it is, what it checks, what it vouched for or
 * listed, and a live record of what it has done, including the fetches it
 * answers without learning who asked.
 */
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Code,
  Container,
  Group,
  Loader,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCertificate,
  IconEye,
  IconListCheck,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { api, boot } from "../boot.ts";

interface Activity {
  at: number;
  kind: "issued" | "suspended" | "reinstated" | "fetched" | "listed" | "distrusted" | "cleared";
  text: string;
}

interface AttesterView {
  name: string;
  origin: string;
  checks: string;
  statusList: string;
  vouched: Array<{
    site: string;
    what: string;
    claims: Record<string, unknown>;
    issuedAt: number;
    expires: number;
    status: "valid" | "suspended";
  }>;
  activity: Activity[];
}

interface ListView {
  name: string;
  origin: string;
  pin: string;
  listed: Array<{ name: string; origin: string; for: string[]; distrusted?: string }>;
  activity: Activity[];
}

const day = (s: number) =>
  new Date(s * 1000).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" });
const time = (s: number) => new Date(s * 1000).toLocaleTimeString();

const KIND_COLOR: Record<Activity["kind"], string> = {
  issued: "teal",
  listed: "teal",
  suspended: "orange",
  distrusted: "red",
  reinstated: "blue",
  cleared: "blue",
  fetched: "gray",
};

/** Polls the party's own registry endpoint, so activity appears as it happens. */
function useRegistry<T>(): T | undefined {
  const [v, setV] = useState<T>();
  useEffect(() => {
    let live = true;
    const load = () =>
      api<T>("/api/registry").then(
        (x) => live && setV(x),
        () => undefined,
      );
    void load();
    const t = setInterval(load, 2500);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return v;
}

function ActivityFeed({ activity }: { activity: Activity[] }) {
  // Status-list and trust-list fetches repeat; group consecutive ones.
  const rows: Array<Activity & { times: number }> = [];
  for (const a of activity) {
    const last = rows.at(-1);
    if (last && last.kind === "fetched" && a.kind === "fetched" && last.text === a.text)
      last.times++;
    else rows.push({ ...a, times: 1 });
  }
  return (
    <Paper withBorder radius="md" p="md">
      <Group gap="xs" mb="sm">
        <IconEye size={18} />
        <Text fw={700}>What it's doing</Text>
        <Text size="xs" c="dimmed">
          live
        </Text>
      </Group>
      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing yet.
        </Text>
      ) : (
        <Stack gap={8}>
          {rows.slice(0, 40).map((a) => (
            <Group key={`${a.at}-${a.kind}-${a.text}`} gap="sm" wrap="nowrap" align="flex-start">
              <Badge
                size="xs"
                variant="light"
                color={KIND_COLOR[a.kind]}
                miw={78}
                style={{ flexShrink: 0 }}
              >
                {a.kind}
              </Badge>
              <Box style={{ minWidth: 0 }}>
                <Text size="sm">
                  {a.text}
                  {a.times > 1 ? ` (${a.times} times)` : ""}
                </Text>
                <Text size="xs" c="dimmed">
                  {time(a.at)}
                </Text>
              </Box>
            </Group>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

function Header({ title, kind, origin }: { title: string; kind: string; origin: string }) {
  return (
    <Group gap="md" mb="lg" wrap="nowrap">
      <ThemeIcon size={48} radius="md" variant="light">
        {kind === "list" ? <IconListCheck size={28} /> : <IconCertificate size={28} />}
      </ThemeIcon>
      <Box>
        <Title order={2}>{title}</Title>
        <Text size="sm" c="dimmed">
          {new URL(origin).host} · {kind === "list" ? "Trust-list publisher" : "Attester"} (RFC
          0010)
        </Text>
      </Box>
    </Group>
  );
}

function Attester() {
  const v = useRegistry<AttesterView>();
  if (!v) return <Loader m="xl" />;
  return (
    <Container size="lg" py="xl">
      <Header title={v.name} kind="attester" origin={v.origin} />
      <Text mb="lg" maw={720}>
        {v.checks} Assistants believe what it signs only because the trust list they pin names it.
        It never sees who applies to a job, or which assistant is checking.
      </Text>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Stack>
          <Text fw={700}>What it has vouched for</Text>
          {v.vouched.map((x) => (
            <Paper key={`${x.site}-${x.what}`} withBorder radius="md" p="md">
              <Group justify="space-between" wrap="nowrap" mb={4}>
                <Text fw={600}>{x.site}</Text>
                {x.status === "valid" ? (
                  <Badge color="teal" variant="light" leftSection={<IconShieldCheck size={12} />}>
                    Valid
                  </Badge>
                ) : (
                  <Badge
                    color="orange"
                    variant="light"
                    leftSection={<IconAlertTriangle size={12} />}
                  >
                    Suspended
                  </Badge>
                )}
              </Group>
              <Text size="sm">{x.what}</Text>
              <Text size="xs" c="dimmed" mt={4}>
                {Object.entries(x.claims)
                  .filter(([k]) => k !== "checked_at")
                  .map(([k, val]) => `${k.replaceAll("_", " ")}: ${String(val)}`)
                  .join(" · ")}
              </Text>
              <Text size="xs" c="dimmed">
                Checked {day(x.issuedAt)} · good until {day(x.expires)}
              </Text>
            </Paper>
          ))}
          <Text size="xs" c="dimmed">
            Anyone can check whether an attestation still stands at{" "}
            <Anchor href={v.statusList} size="xs">
              its status list
            </Anchor>
            , one list for everything it signed, so a fetch says nothing about which one.
          </Text>
        </Stack>
        <ActivityFeed activity={v.activity} />
      </SimpleGrid>
    </Container>
  );
}

function TrustList() {
  const v = useRegistry<ListView>();
  if (!v) return <Loader m="xl" />;
  return (
    <Container size="lg" py="xl">
      <Header title={v.name} kind="list" origin={v.origin} />
      <Text mb="lg" maw={720}>
        JobGPT pins this list by its key, the way a browser ships with certificate authorities. It
        says which attesters to believe, and for what. Distrusting an attester here undoes
        everything that attester signed, at once, for every assistant that pins the list.
      </Text>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Stack>
          <Text fw={700}>Attesters it lists</Text>
          {v.listed.map((a) => (
            <Paper key={a.origin} withBorder radius="md" p="md">
              <Group justify="space-between" wrap="nowrap" mb={4}>
                <Anchor href={`${a.origin}/`} fw={600}>
                  {a.name}
                </Anchor>
                {a.distrusted ? (
                  <Badge color="red" variant="light">
                    Distrusted
                  </Badge>
                ) : (
                  <Badge color="teal" variant="light">
                    Trusted
                  </Badge>
                )}
              </Group>
              <Text size="sm">Believed when it says a company {a.for.join(", or ")}.</Text>
              {a.distrusted && (
                <Alert color="red" mt="xs" p="xs">
                  <Text size="xs">Distrusted: {a.distrusted}</Text>
                </Alert>
              )}
            </Paper>
          ))}
          <Text size="xs" c="dimmed">
            Pinned key thumbprint <Code>{v.pin}</Code>. The signed list:{" "}
            <Anchor href="/trust-list.jwt" size="xs">
              trust-list.jwt
            </Anchor>
            .
          </Text>
        </Stack>
        <ActivityFeed activity={v.activity} />
      </SimpleGrid>
      <Text size="xs" c="dimmed" mt="xl">
        Try it: under the hood, the lab's "Distrust an attester" incident lands here.{" "}
        <Anchor href={`${boot.origins.home}/hood`} size="xs">
          Open the lab
        </Anchor>
      </Text>
    </Container>
  );
}

export function Registry() {
  return boot.role === "lists" ? <TrustList /> : <Attester />;
}
