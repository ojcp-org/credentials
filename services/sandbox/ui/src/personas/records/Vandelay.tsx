/**
 * Vandelay Industries' own employee intranet: the plain, slightly dated
 * in-house portal a mid-size importer/exporter runs. Company news, a staff
 * card, and HR's own personnel file, signed by Vandelay itself.
 */
import {
  Alert,
  Anchor,
  Box,
  Button,
  Container,
  Grid,
  Group,
  Paper,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { IconWallet } from "@tabler/icons-react";
import { VANDELAY, VandelayMark } from "../../brands.tsx";
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

const SERIF = "Georgia, 'Times New Roman', serif";

export function VandelaySite({ me }: { me: Me | undefined }) {
  return (
    <Box bg="#ecebe6" mih="100vh" style={{ fontFamily: SERIF }}>
      <Box bg="white" style={{ borderBottom: `4px double ${VANDELAY.green}` }}>
        <Container size="lg" py="sm">
          <Group justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
              <VandelayMark size={36} />
              <Box>
                <Text fw={700} size="xl" c={VANDELAY.deep} ff={SERIF} lh={1}>
                  Vandelay Industries
                </Text>
                <Text size="xs" c="dimmed" ff={SERIF} fs="italic">
                  Importers · Exporters · Since 1989
                </Text>
              </Box>
            </Group>
            <Text size="sm" ff={SERIF} visibleFrom="xs">
              Staff intranet
            </Text>
          </Group>
        </Container>
        <Box bg={VANDELAY.green}>
          <Container size="lg">
            <Group gap="lg" py={6}>
              {[
                { label: "Home" },
                { label: "Company News" },
                { label: "Directory" },
                { label: "My Personnel File", href: "/", active: page === "records" },
                { label: "Our Records Policy", href: "/practice", active: page === "practice" },
              ].map((l) =>
                l.href ? (
                  <Anchor
                    key={l.label}
                    href={l.href}
                    c="white"
                    size="sm"
                    ff={SERIF}
                    fw={l.active ? 700 : 400}
                    underline={l.active ? "always" : "hover"}
                  >
                    {l.label}
                  </Anchor>
                ) : (
                  <Text key={l.label} c="#cfe3dc" size="sm" ff={SERIF}>
                    {l.label}
                  </Text>
                ),
              )}
            </Group>
          </Container>
        </Box>
      </Box>
      <Container size="lg" py="lg">
        <Grid gutter="lg">
          <Grid.Col span={{ base: 12, md: 8 }}>
            {me && (page === "practice" ? <Practice me={me} /> : <File me={me} />)}
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Paper p="md" radius={0} withBorder bg="white" mb="md">
              <Text fw={700} ff={SERIF} c={VANDELAY.deep} mb={4}>
                {me?.employee.name ?? ""}
              </Text>
              <Text size="sm" ff={SERIF}>
                {me ? currentTitle(me) : ""}
              </Text>
              <Text size="xs" c="dimmed" ff={SERIF}>
                Employee no. E1042 · Latex division
              </Text>
            </Paper>
            <Paper p="md" radius={0} withBorder bg="#fbfaf5">
              <Text fw={700} ff={SERIF} c={VANDELAY.deep} mb={4}>
                Company news
              </Text>
              <Text size="sm" ff={SERIF}>
                Q3 latex shipments up 12%. Thanks, everyone.
              </Text>
              <Text size="xs" c="dimmed" ff={SERIF} mt={6}>
                From the desk of Art Vandelay
              </Text>
            </Paper>
          </Grid.Col>
        </Grid>
      </Container>
    </Box>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Paper radius={0} withBorder bg="white">
      <Box bg={VANDELAY.tint} px="md" py={8} style={{ borderBottom: "1px solid #d9e2de" }}>
        <Text fw={700} ff={SERIF} c={VANDELAY.deep}>
          {title}
        </Text>
      </Box>
      <Box p="md">{children}</Box>
    </Paper>
  );
}

function File({ me }: { me: Me }) {
  const { add, busy, error } = useAddToWallet();
  return (
    <Stack gap="md">
      <Panel title="My personnel file">
        <Table withTableBorder withColumnBorders fz="sm" ff={SERIF}>
          <Table.Tbody>
            <Table.Tr>
              <Table.Td w={160} bg="#fbfaf5">
                Status
              </Table.Td>
              <Table.Td>{me.record.current ? "Current employee" : "Former employee"}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td bg="#fbfaf5">Joined</Table.Td>
              <Table.Td>{month(me.record.start)}</Table.Td>
            </Table.Tr>
            {[...me.record.positionHistories].reverse().map((p) => (
              <Table.Tr key={p.title}>
                <Table.Td bg="#fbfaf5">Position</Table.Td>
                <Table.Td>
                  {p.title}, {month(p.start)} – {p.end ? month(p.end) : "present"}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {error && (
          <Alert color="red" mt="sm">
            {error}
          </Alert>
        )}
        <Group mt="md">
          <Button radius={0} leftSection={<IconWallet size={16} />} loading={busy} onClick={add}>
            Add to my wallet
          </Button>
          <Text size="xs" c="dimmed" ff={SERIF}>
            From HR's own records. Any time, not just when you leave.
          </Text>
        </Group>
      </Panel>
      <Panel title="About this record">
        <Stack gap={6}>
          {promises(me).map((p) => (
            <Text key={p} size="sm" ff={SERIF}>
              • {p}
            </Text>
          ))}
        </Stack>
        <Text size="xs" c="dimmed" mt="sm" ff={SERIF}>
          {signedBy(me)}
        </Text>
      </Panel>
    </Stack>
  );
}

function Practice({ me }: { me: Me }) {
  return (
    <Panel title="Our records policy">
      <Vouch me={me} />
    </Panel>
  );
}
