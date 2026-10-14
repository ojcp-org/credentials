/**
 * The sandbox's front door: what this is, in a minute, before any protocol.
 * One story, four characters, three things to notice, one button.
 * "Under the hood" (/hood) has the technical view.
 */
import {
  Anchor,
  Box,
  Button,
  Container,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconArrowRight,
  IconBriefcase,
  IconEyeOff,
  IconHandStop,
  IconMessageChatbot,
  IconShieldCheck,
  IconUser,
  IconWallet,
} from "@tabler/icons-react";
import { boot } from "../boot.ts";
import { useStory } from "../chrome/SandboxBar.tsx";
import { OJCP } from "../theme.ts";

const CAST = [
  {
    icon: IconUser,
    name: "Jordan",
    line: "Wants a new data job. You play him.",
  },
  {
    icon: IconMessageChatbot,
    name: "JobGPT",
    line: "His AI assistant. It finds jobs and applies for him.",
  },
  {
    icon: IconWallet,
    name: "Jordan's wallet",
    line: "An app on his phone. It holds his work record and his say-so.",
  },
  {
    icon: IconBriefcase,
    name: "Acme and others",
    line: "Employers receiving the applications.",
  },
];

const NOTICE = [
  {
    icon: IconHandStop,
    title: "Jordan sets the limits",
    text: "JobGPT can only apply to the kinds of jobs Jordan approved, a few per company, and he can cancel at any time. It can't give itself more.",
  },
  {
    icon: IconShieldCheck,
    title: "Employers check first",
    text: "Every application carries proof of what Jordan allowed. The employer's system checks it, and turns away anything outside it.",
  },
  {
    icon: IconEyeOff,
    title: "The assistant never sees private records",
    text: "When Acme wants to confirm his work history, it comes straight from his wallet. JobGPT only learns that it's done.",
  },
];

export function Welcome() {
  const story = useStory();
  const started = story?.steps.some((s) => s.done) ?? false;
  const next = story?.steps.find((s) => s.n === story.current) ?? story?.steps[0];

  return (
    <Box bg={OJCP.obsidian} mih="calc(100vh - var(--bar-h, 116px))" c={OJCP.text}>
      <Container size="md" py={{ base: 40, sm: 72 }}>
        <Stack gap={56}>
          <Box maw={680}>
            <Text c={OJCP.gold} fw={700} size="sm" tt="uppercase" mb="xs" ff={OJCP.mono}>
              A five-minute story
            </Text>
            <Title order={1} c={OJCP.text} mb="md" style={{ fontSize: "clamp(30px, 5vw, 44px)" }}>
              Watch an AI assistant apply for jobs, without being handed the keys.
            </Title>
            <Text size="lg" c={OJCP.muted} mb="xl">
              AI assistants are starting to apply for jobs on people's behalf. That raises fair
              questions: what is it allowed to do, how does an employer know, and who sees your
              private details? OJCP is an open set of rules that answers them. This sandbox shows it
              working, step by step.
            </Text>
            <Group gap="sm">
              {next && (
                <Button
                  component="a"
                  href={next.href}
                  size="md"
                  color="ojcpGold"
                  c={OJCP.obsidian}
                  rightSection={<IconArrowRight size={18} />}
                >
                  {started ? `Continue: ${next.title}` : "Start the story"}
                </Button>
              )}
              <Button component="a" href={`${boot.origins.agent}/`} size="md" variant="default">
                Skip to the assistant
              </Button>
            </Group>
          </Box>

          <Box>
            <Title order={2} size="h4" c={OJCP.text} mb="md">
              Who's who
            </Title>
            <SimpleGrid cols={{ base: 1, xs: 2, sm: 4 }} spacing="md">
              {CAST.map((c) => (
                <Paper key={c.name} p="md" radius="md" bg={OJCP.surface} withBorder>
                  <ThemeIcon size={36} radius="xl" color="ojcpGold" variant="light" mb="sm">
                    <c.icon size={20} />
                  </ThemeIcon>
                  <Text fw={700} c={OJCP.text}>
                    {c.name}
                  </Text>
                  <Text size="sm" c={OJCP.muted}>
                    {c.line}
                  </Text>
                </Paper>
              ))}
            </SimpleGrid>
          </Box>

          <Box>
            <Title order={2} size="h4" c={OJCP.text} mb="md">
              Three things to watch for
            </Title>
            <Stack gap="md">
              {NOTICE.map((n, i) => (
                <Group key={n.title} gap="md" wrap="nowrap" align="flex-start">
                  <ThemeIcon size={40} radius="md" color="ojcpGold" variant="light">
                    <n.icon size={22} />
                  </ThemeIcon>
                  <Box>
                    <Text fw={700} c={OJCP.text}>
                      {i + 1}. {n.title}
                    </Text>
                    <Text c={OJCP.muted}>{n.text}</Text>
                  </Box>
                </Group>
              ))}
            </Stack>
          </Box>

          <Paper p="lg" radius="md" bg={OJCP.surface} withBorder>
            <Title order={2} size="h5" c={OJCP.text} mb="xs">
              How to follow along
            </Title>
            <Text size="sm" c={OJCP.muted}>
              The bar at the top walks you through ten steps; press <b>Next</b> to move on. Each tab
              is a separate website, run by a different party, so watch the address bar change.
              Short notes in the bottom corner say what's happening behind the scenes. Everything is
              made up: people, companies and keys.
            </Text>
            <Text size="sm" c={OJCP.muted} mt="sm">
              Building with OJCP?{" "}
              <Anchor href={`${boot.origins.home}/hood`} c={OJCP.gold}>
                Under the hood
              </Anchor>{" "}
              shows every message between the parties, who trusts whom, and a lab for breaking
              things.
            </Text>
          </Paper>
        </Stack>
      </Container>
    </Box>
  );
}
