/**
 * WorkSecond, the HR platform Vandelay uses: a wink at Workday. A white top
 * bar with search, a greeting, a row of apps, and the employee's records as a
 * worklet.
 */
import {
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  Container,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Timeline,
  Title,
  UnstyledButton,
} from "@mantine/core";
import {
  IconBell,
  IconBriefcase,
  IconCalendar,
  IconCash,
  IconCheck,
  IconFileCertificate,
  IconSearch,
  IconShieldCheck,
  IconUser,
  IconWallet,
} from "@tabler/icons-react";
import { WORKSECOND, WorkSecondMark } from "../../brands.tsx";
import {
  currentTitle,
  type Me,
  month,
  page,
  promises,
  signedBy,
  useAddToWallet,
  Vouch,
} from "./shared.tsx";

const APPS = [
  { icon: IconUser, label: "Personal Information" },
  { icon: IconCash, label: "Pay" },
  { icon: IconCalendar, label: "Time Off" },
  { icon: IconBriefcase, label: "Career" },
  { icon: IconFileCertificate, label: "My Records", href: "/" },
  { icon: IconShieldCheck, label: "What We Vouch For", href: "/practice" },
];

export function WorkSecondSite({ me }: { me: Me | undefined }) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <Box bg={WORKSECOND.tint} mih="100vh">
      <Box bg="white" style={{ borderBottom: "1px solid #e3e8ef" }}>
        <Container size="lg" py={10}>
          <Group justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
              <WorkSecondMark />
              <Text fw={800} size="lg" c={WORKSECOND.navy} style={{ letterSpacing: -0.3 }}>
                work<span style={{ color: WORKSECOND.orange }}>second</span>
              </Text>
            </Group>
            <TextInput
              visibleFrom="sm"
              w={360}
              radius="xl"
              placeholder="Search"
              leftSection={<IconSearch size={16} />}
              readOnly
            />
            <Group gap="md" wrap="nowrap">
              <IconBell size={20} color="#5b6b82" />
              <Avatar color="blue" radius="xl" size="sm">
                JL
              </Avatar>
            </Group>
          </Group>
        </Container>
      </Box>
      <Box
        c="white"
        style={{ background: `linear-gradient(100deg, ${WORKSECOND.navy}, ${WORKSECOND.blue})` }}
      >
        <Container size="lg" py={28}>
          <Text size="sm" c="#b9c8e6">
            {me?.employer.name ?? ""}
          </Text>
          <Title order={2} c="white" fw={500}>
            {greeting}, {me?.employee.name.split(" ")[0] ?? "Jordan"}
          </Title>
          <Text size="sm" c="#d7e2f5">
            {me ? currentTitle(me) : ""}
          </Text>
        </Container>
      </Box>
      <Container size="lg" py="lg">
        <SimpleGrid cols={{ base: 3, sm: 6 }} spacing="sm" mb="lg">
          {APPS.map((a) => {
            const active = a.href === (page === "practice" ? "/practice" : "/");
            return (
              <UnstyledButton
                key={a.label}
                component="a"
                href={a.href ?? undefined}
                style={{ cursor: a.href ? "pointer" : "default", opacity: a.href ? 1 : 0.55 }}
              >
                <Paper
                  p="sm"
                  radius="md"
                  ta="center"
                  withBorder
                  style={
                    active
                      ? { borderColor: WORKSECOND.blue, boxShadow: `0 0 0 1px ${WORKSECOND.blue}` }
                      : undefined
                  }
                >
                  <ThemeIcon size={40} radius="xl" variant="light" mx="auto" mb={6}>
                    <a.icon size={20} />
                  </ThemeIcon>
                  <Text size="xs" fw={600} c={WORKSECOND.navy}>
                    {a.label}
                  </Text>
                </Paper>
              </UnstyledButton>
            );
          })}
        </SimpleGrid>
        {me && (page === "practice" ? <Practice me={me} /> : <Records me={me} />)}
      </Container>
    </Box>
  );
}

function Records({ me }: { me: Me }) {
  const { add, busy, error } = useAddToWallet();
  const positions = [...me.record.positionHistories].reverse();
  return (
    <SimpleGrid cols={{ base: 1, md: 3 }} spacing="lg">
      <Paper withBorder radius="md" p="lg" style={{ gridColumn: "span 2" }}>
        <Group justify="space-between" mb="md">
          <Text fw={700} c={WORKSECOND.navy}>
            Employment record
          </Text>
          <Badge color="teal" variant="light">
            {me.record.current ? "Active" : "Terminated"}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed" mb="sm">
          {me.employer.name} · hired {month(me.record.start)}
        </Text>
        <Timeline active={0} bulletSize={16} lineWidth={2} mb="lg">
          {positions.map((p) => (
            <Timeline.Item key={p.title} title={p.title}>
              <Text size="sm" c="dimmed">
                {month(p.start)} – {p.end ? month(p.end) : "present"}
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
          <Button leftSection={<IconWallet size={18} />} loading={busy} onClick={add} radius="xl">
            Add to my wallet
          </Button>
          <Text size="xs" c="dimmed">
            Any time, not just when you leave.
          </Text>
        </Group>
      </Paper>
      <Paper withBorder radius="md" p="lg">
        <Text fw={700} c={WORKSECOND.navy} mb="sm">
          About this record
        </Text>
        <Stack gap={8}>
          {promises(me).map((p) => (
            <Group key={p} gap={8} wrap="nowrap" align="flex-start">
              <IconCheck
                size={16}
                color={WORKSECOND.blue}
                style={{ flexShrink: 0, marginTop: 2 }}
              />
              <Text size="sm">{p}</Text>
            </Group>
          ))}
        </Stack>
        <Text size="xs" c="dimmed" mt="md">
          {signedBy(me)} If you leave, we send a former-employee record to your personal email.
        </Text>
      </Paper>
    </SimpleGrid>
  );
}

function Practice({ me }: { me: Me }) {
  return (
    <Paper withBorder radius="md" p="lg">
      <Text fw={700} c={WORKSECOND.navy} mb="sm">
        What we vouch for
      </Text>
      <Vouch me={me} />
    </Paper>
  );
}
