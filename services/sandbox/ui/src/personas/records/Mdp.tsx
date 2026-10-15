/**
 * MDP (Manual Data Processing), Vandelay's payroll provider: a wink at ADP. A
 * red masthead, a left rail, and a dashboard of tiles: the latest pay
 * statement (masked), and the employment record.
 */
import {
  Alert,
  Box,
  Button,
  Divider,
  Group,
  NavLink,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import {
  IconBuildingBank,
  IconFileCertificate,
  IconFileInvoice,
  IconHome,
  IconLock,
  IconReceiptTax,
  IconShieldCheck,
  IconWallet,
} from "@tabler/icons-react";
import { MDP, MdpMark } from "../../brands.tsx";
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

export function MdpSite({ me }: { me: Me | undefined }) {
  return (
    <Box bg="#f3f3f3" mih="100vh">
      <Box bg={MDP.red} c="white">
        <Group justify="space-between" px="lg" py={10} wrap="nowrap">
          <Group gap="md" wrap="nowrap">
            <MdpMark />
            <Text fw={600} size="sm" visibleFrom="xs" style={{ letterSpacing: 0.3 }}>
              MyMDP
            </Text>
          </Group>
          <Group gap="lg" wrap="nowrap">
            <Text size="sm" visibleFrom="sm">
              {me?.employer.name ?? ""}
            </Text>
            <Text size="sm" fw={600}>
              {me?.employee.name ?? ""}
            </Text>
          </Group>
        </Group>
      </Box>
      <Group align="stretch" gap={0} wrap="nowrap">
        <Box
          w={210}
          bg="white"
          visibleFrom="sm"
          style={{ borderRight: "1px solid #e1e1e1", minHeight: "calc(100vh - 52px)" }}
          py="sm"
        >
          {[
            { icon: IconHome, label: "Home" },
            { icon: IconFileInvoice, label: "Pay" },
            { icon: IconReceiptTax, label: "Tax Statements" },
            { icon: IconBuildingBank, label: "Direct Deposit" },
            {
              icon: IconFileCertificate,
              label: "Employment Record",
              href: "/",
              active: page === "records",
            },
            {
              icon: IconShieldCheck,
              label: "What We Vouch For",
              href: "/practice",
              active: page === "practice",
            },
          ].map((n) => (
            <NavLink
              key={n.label}
              label={n.label}
              leftSection={<n.icon size={18} />}
              {...(n.href ? { href: n.href } : { disabled: true })}
              active={n.active ?? false}
              color="red"
              variant="light"
              styles={{ label: { fontSize: 14 } }}
            />
          ))}
        </Box>
        <Box p="lg" style={{ flex: 1, minWidth: 0 }}>
          {me && (page === "practice" ? <Practice me={me} /> : <Dashboard me={me} />)}
        </Box>
      </Group>
    </Box>
  );
}

function Tile({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Paper radius={4} p="md" bg="white" style={{ borderTop: `3px solid ${MDP.red}` }}>
      <Text fw={700} size="sm" tt="uppercase" c={MDP.ink} mb="sm" style={{ letterSpacing: 0.5 }}>
        {title}
      </Text>
      {children}
    </Paper>
  );
}

function Dashboard({ me }: { me: Me }) {
  const { add, busy, error } = useAddToWallet();
  return (
    <Stack gap="md" maw={1000}>
      <Title order={3} fw={500} c={MDP.ink}>
        Welcome, {me.employee.name.split(" ")[0]}
      </Title>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Tile title="Latest pay statement">
          <Group justify="space-between" align="flex-end">
            <Box>
              <Text size="xs" c="dimmed">
                Pay date
              </Text>
              <Text fw={600}>Last Friday</Text>
            </Box>
            <Group gap={4}>
              <IconLock size={14} color="gray" />
              <Text size="xl" fw={700} c={MDP.ink}>
                $•,•••.••
              </Text>
            </Group>
          </Group>
          <Text size="xs" c="dimmed" mt="sm">
            Pay isn't part of your employment record, and never goes to employers.
          </Text>
        </Tile>
        <Tile title="Employment record">
          <Table withRowBorders={false} verticalSpacing={4} fz="sm">
            <Table.Tbody>
              <Table.Tr>
                <Table.Td c="dimmed">Company</Table.Td>
                <Table.Td fw={600}>{me.employer.name}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td c="dimmed">Position</Table.Td>
                <Table.Td fw={600}>{currentTitle(me)}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td c="dimmed">Hire date</Table.Td>
                <Table.Td fw={600}>{month(me.record.start)}</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td c="dimmed">Status</Table.Td>
                <Table.Td fw={600}>{me.record.current ? "Active" : "Terminated"}</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>
          {error && (
            <Alert color="red" mt="sm">
              {error}
            </Alert>
          )}
          <Button
            mt="md"
            radius={4}
            leftSection={<IconWallet size={16} />}
            loading={busy}
            onClick={add}
          >
            Add to my wallet
          </Button>
        </Tile>
      </SimpleGrid>
      <Tile title="Positions held">
        <Table striped fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Title</Table.Th>
              <Table.Th>From</Table.Th>
              <Table.Th>To</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {[...me.record.positionHistories].reverse().map((p) => (
              <Table.Tr key={p.title}>
                <Table.Td>{p.title}</Table.Td>
                <Table.Td>{month(p.start)}</Table.Td>
                <Table.Td>{p.end ? month(p.end) : "Present"}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Tile>
      <Tile title="About your employment record">
        <Stack gap={6}>
          {promises(me).map((p) => (
            <Text key={p} size="sm">
              • {p}
            </Text>
          ))}
        </Stack>
        <Divider my="sm" />
        <Text size="xs" c="dimmed">
          {signedBy(me)}
        </Text>
      </Tile>
    </Stack>
  );
}

function Practice({ me }: { me: Me }) {
  return (
    <Tile title="What we vouch for">
      <Vouch me={me} />
    </Tile>
  );
}
