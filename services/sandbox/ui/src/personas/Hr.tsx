/**
 * Tab 1: the HR platform Jordan's employer uses (WorkSecond, a wink at Workday). He's a
 * current employee, signed in, and can put a signed record of his job in his
 * wallet whenever he likes (RFC 0014 §4.1).
 */
import {
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  Container,
  Grid,
  Group,
  List,
  NavLink,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Timeline,
  Title,
} from "@mantine/core";
import {
  IconBriefcase,
  IconCheck,
  IconFileCertificate,
  IconInfoCircle,
  IconShieldCheck,
  IconWallet,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { api, boot } from "../boot.ts";
import { WORKSECOND, WorkSecondMark } from "../brands.tsx";

interface Me {
  platform: string;
  employer: { name: string; id: string };
  employee: { name: string; email: string };
  record: {
    current: boolean;
    start: string;
    positionHistories: Array<{ title: string; start: string; end?: string }>;
  };
  basis: string;
  issuer: string;
}

const month = (d: string) =>
  new Date(`${d.length === 7 ? `${d}-01` : d}T00:00:00Z`).toLocaleDateString("en", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

function Shell({
  me,
  page,
  children,
}: {
  me: Me | undefined;
  page: string;
  children: React.ReactNode;
}) {
  return (
    <Box bg={WORKSECOND.tint} mih="100vh">
      <Box
        bg={WORKSECOND.navy}
        c="white"
        style={{ borderBottom: `3px solid ${WORKSECOND.orange}` }}
      >
        <Container size="lg" py="sm">
          <Group justify="space-between">
            <Group gap="sm">
              <WorkSecondMark />
              <Text fw={800} size="lg" style={{ letterSpacing: -0.3 }}>
                work<span style={{ color: WORKSECOND.orange }}>second</span>
              </Text>
              <Text c="#b9c8e6" size="sm" visibleFrom="xs">
                · {me?.employer.name ?? ""}
              </Text>
            </Group>
            <Group gap="xs">
              <Avatar color="orange" radius="xl" size="sm">
                JL
              </Avatar>
              <Text size="sm">{me?.employee.name ?? boot.candidate.name}</Text>
            </Group>
          </Group>
        </Container>
      </Box>
      <Container size="lg" py="xl">
        <Grid gutter="xl">
          <Grid.Col span={{ base: 12, sm: 3 }}>
            <Paper withBorder radius="md" p={4}>
              <NavLink
                href="/"
                label="My records"
                active={page === "records"}
                leftSection={<IconFileCertificate size={16} />}
              />
              <NavLink
                href="/practice"
                label="What we vouch for"
                active={page === "practice"}
                leftSection={<IconShieldCheck size={16} />}
              />
            </Paper>
          </Grid.Col>
          <Grid.Col span={{ base: 12, sm: 9 }}>{children}</Grid.Col>
        </Grid>
      </Container>
    </Box>
  );
}

function Records({ me }: { me: Me }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const positions = [...me.record.positionHistories].reverse();

  async function addToWallet() {
    setBusy(true);
    setError(undefined);
    try {
      const { offerUri } = await api<{ offerUri: string }>("/api/hr/wallet-offer", {});
      // Same device: the offer link opens the wallet, as a phone would hand it to the wallet app.
      const query = offerUri.slice(offerUri.indexOf("?"));
      location.href = `${boot.origins.wallet}/offer${query}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Stack gap="lg">
      <Box>
        <Title order={2}>My records</Title>
        <Text c="dimmed">Signed records of your job that you keep, and share when you choose.</Text>
      </Box>
      <Paper withBorder radius="md" p="lg">
        <Group justify="space-between" align="flex-start" mb="md">
          <Group gap="sm">
            <ThemeIcon size={40} radius="md" variant="light">
              <IconBriefcase size={22} />
            </ThemeIcon>
            <Box>
              <Text fw={700} size="lg">
                Employment at {me.employer.name}
              </Text>
              <Text size="sm" c="dimmed">
                Since {month(me.record.start)}
              </Text>
            </Box>
          </Group>
          <Badge color="teal" variant="light">
            {me.record.current ? "Current employee" : "Former employee"}
          </Badge>
        </Group>
        <Timeline active={0} bulletSize={18} lineWidth={2} mb="lg">
          {positions.map((p) => (
            <Timeline.Item key={p.title} title={p.title}>
              <Text size="sm" c="dimmed">
                {month(p.start)} – {p.end ? month(p.end) : "now"}
              </Text>
            </Timeline.Item>
          ))}
        </Timeline>
        {error && (
          <Alert color="red" mb="md">
            {error}
          </Alert>
        )}
        <Group>
          <Button
            size="md"
            leftSection={<IconWallet size={18} />}
            loading={busy}
            onClick={addToWallet}
          >
            Add to my wallet
          </Button>
          <Text size="sm" c="dimmed">
            Opens your wallet on this device. Available any time, not just when you leave.
          </Text>
        </Group>
      </Paper>
      <Paper withBorder radius="md" p="lg">
        <Text fw={700} mb="sm">
          What this record does
        </Text>
        <List
          spacing="xs"
          size="sm"
          icon={
            <ThemeIcon size={20} radius="xl" color="teal" variant="light">
              <IconCheck size={13} />
            </ThemeIcon>
          }
        >
          <List.Item>
            A future employer can confirm where you work, your job titles and how long you've been
            here, without calling us.
          </List.Item>
          <List.Item>
            You share only what an employer asks for. Exact dates and the rest stay in your wallet.
          </List.Item>
          <List.Item>
            {me.employer.name} isn't told when or where you use it. Employers check its status
            against a list shared by every customer of ours, fetched on a schedule.
          </List.Item>
          <List.Item>It never includes pay, ratings or reasons for leaving.</List.Item>
        </List>
      </Paper>
      <Alert variant="light" color="gray" icon={<IconInfoCircle />}>
        Signed by {me.platform}, reporting what {me.employer.name} recorded in our system. If you
        leave, we send a former-employee record to your personal email.
      </Alert>
    </Stack>
  );
}

function Practice({ me }: { me: Me }) {
  return (
    <Stack gap="lg">
      <Title order={2}>What we vouch for</Title>
      <Paper withBorder radius="md" p="lg">
        <List spacing="sm" size="sm">
          <List.Item>
            <b>Basis:</b> <code>{me.basis}</code>. We sign in our own name, reporting what our
            customer recorded (RFC 0014 §3).
          </List.Item>
          <List.Item>
            <b>Customers:</b> we confirm each customer's business registration before it can issue
            records through us.
          </List.Item>
          <List.Item>
            <b>Status:</b> we update a record's status within 7 days of the change that ends it.
          </List.Item>
          <List.Item>
            <b>Keys:</b> published at <code>{me.issuer}/.well-known/jwt-vc-issuer</code>, each with
            the date we stop signing with it.
          </List.Item>
          <List.Item>
            <b>Consumer reporting:</b> we don't act as a consumer reporting agency for these
            records.
          </List.Item>
        </List>
      </Paper>
    </Stack>
  );
}

export function Hr() {
  const [me, setMe] = useState<Me>();
  useEffect(() => {
    api<Me>("/api/hr/me").then(setMe);
  }, []);
  const page = location.pathname === "/practice" ? "practice" : "records";
  return (
    <Shell me={me} page={page}>
      {me && (page === "practice" ? <Practice me={me} /> : <Records me={me} />)}
    </Shell>
  );
}
