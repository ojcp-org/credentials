/**
 * The sandbox's own chrome, on every party's page: the five persona tabs, where
 * the story is, and Jordan's inbox. It sits above each site like a browser frame,
 * in OJCP's colours, so it never reads as part of the site below.
 */
import {
  Anchor,
  Badge,
  Box,
  Button,
  Drawer,
  Group,
  Indicator,
  Paper,
  Popover,
  ScrollArea,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowRight,
  IconBriefcase,
  IconBuildingSkyscraper,
  IconCheck,
  IconListDetails,
  IconMail,
  IconMessageChatbot,
  IconRefresh,
  IconStack2,
  IconWallet,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import ojcpIcon from "../assets/ojcp-icon.svg";
import { boot, type Role } from "../boot.ts";
import { OJCP } from "../theme.ts";

export type Tab = "hr" | "wallet" | "assistant" | "employer" | "hood";

/** A page, by origin and path; `prefix` matches every path under it. */
interface StoryPage {
  url: string;
  prefix?: true;
}

export interface StoryStep {
  n: number;
  tab: Tab;
  title: string;
  detail: string;
  href: string;
  at: StoryPage[];
  done: boolean;
}

interface InboxMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  at: number;
}

interface Story {
  steps: StoryStep[];
  current: number;
  inbox: InboxMessage[];
}

const TABS: Array<{
  tab: Tab;
  label: string;
  who: string;
  role: Role;
  path?: string;
  icon: typeof IconWallet;
}> = [
  {
    tab: "hr",
    label: "Records",
    who: "Where Jordan's work record comes from: WorkSecond (HR), MDP (payroll) or Vandelay",
    role: "hr",
    icon: IconBuildingSkyscraper,
  },
  {
    tab: "wallet",
    label: "Wallet",
    who: "Jordan's phone: records and permissions",
    role: "wallet",
    icon: IconWallet,
  },
  {
    tab: "assistant",
    label: "Assistant",
    who: "JobGPT, Jordan's AI assistant",
    role: "agent",
    icon: IconMessageChatbot,
  },
  {
    tab: "employer",
    label: "Employer",
    who: "Acme Corporation",
    role: "acme",
    icon: IconBriefcase,
  },
  {
    tab: "hood",
    label: "Under the hood",
    who: "How it works",
    role: "home",
    path: "hood",
    icon: IconStack2,
  },
];

const TAB_OF: Partial<Record<Role, Tab>> = {
  hr: "hr",
  mdp: "hr",
  vandelay: "hr",
  wallet: "wallet",
  agent: "assistant",
  acme: "employer",
  ats: "employer",
  globex: "employer",
  lookalike: "employer",
  home: "hood",
  // The trust network: its attesters and trust list are explored from under the hood.
  attestA: "hood",
  attestB: "hood",
  lists: "hood",
};

// The welcome page (home's `/`) is before the story, so no tab is lit there.
export const activeTab: Tab | undefined =
  boot.role === "home" && location.pathname !== "/hood" ? undefined : TAB_OF[boot.role];

/** The tab a link lands on, from its origin. */
function tabOfHref(href: string): Tab | undefined {
  const origin = new URL(href).origin;
  const role = (Object.keys(boot.origins) as Role[]).find((r) => boot.origins[r] === origin);
  return role ? TAB_OF[role] : undefined;
}

const pageOf = (url: URL | Location): string => `${url.origin}${url.pathname}`;

/** Whether this page is one where the step can be done. */
function isHere(step: StoryStep): boolean {
  const current = pageOf(location);
  return step.at.some((p) => (p.prefix ? current.startsWith(p.url) : current === p.url));
}

/** Polls the story; every origin serves it under /_sandbox/. */
export function useStory(): Story | undefined {
  const [story, setStory] = useState<Story>();
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch("/_sandbox/story")
        .then((r) => r.json() as Promise<Story>)
        .then((s) => live && setStory(s))
        .catch(() => undefined);
    load();
    const t = setInterval(load, 2500);
    window.addEventListener("focus", load);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener("focus", load);
    };
  }, []);
  return story;
}

function StepList({ steps, current }: { steps: StoryStep[]; current: number }) {
  return (
    <Stack gap={6}>
      {steps.map((s) => (
        <Group key={s.n} gap="sm" wrap="nowrap" align="flex-start">
          <ThemeIcon
            size={22}
            radius="xl"
            color={s.done ? "teal" : s.n === current ? "ojcpGold" : "dark"}
            variant={s.done || s.n === current ? "filled" : "light"}
          >
            {s.done ? <IconCheck size={13} /> : <Text size="xs">{s.n}</Text>}
          </ThemeIcon>
          <Box>
            <Anchor href={s.href} size="sm" c={OJCP.text} fw={s.n === current ? 700 : 400}>
              {s.title}
            </Anchor>
            <Text size="xs" c={OJCP.muted}>
              {TABS.find((t) => t.tab === s.tab)?.label} · {s.detail}
            </Text>
          </Box>
        </Group>
      ))}
    </Stack>
  );
}

function Inbox({ messages }: { messages: InboxMessage[] }) {
  if (messages.length === 0)
    return (
      <Text c="dimmed" ta="center" py="xl">
        No messages yet.
      </Text>
    );
  return (
    <Stack>
      {[...messages].reverse().map((m) => {
        const code = m.text.match(/code is (\d{6})/)?.[1];
        return (
          <Paper key={`${m.at}-${m.subject}`} withBorder p="md" radius="md">
            <Group justify="space-between" mb={4}>
              <Text size="sm" fw={600}>
                {m.from}
              </Text>
              <Text size="xs" c="dimmed">
                {new Date(m.at * 1000).toLocaleTimeString()}
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              To {m.to}
            </Text>
            <Text fw={600} mt={6}>
              {m.subject}
            </Text>
            <Text size="sm">{m.text}</Text>
            {code && (
              <Text ff="monospace" fz={26} fw={700} lts={4} mt="xs">
                {code}
              </Text>
            )}
          </Paper>
        );
      })}
    </Stack>
  );
}

export function SandboxBar() {
  const story = useStory();
  const [inboxOpen, setInboxOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Pages size themselves below the bar, whatever its height (it wraps on narrow screens).
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const set = () =>
      document.documentElement.style.setProperty(
        "--bar-h",
        `${el.getBoundingClientRect().height}px`,
      );
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const step = story?.steps.find((s) => s.n === story.current);
  const here = step ? isHere(step) : false;
  // The step's way forward is a button on this page, e.g. Acme's "Open my wallet".
  const nextIsThisPage = step ? pageOf(new URL(step.href)) === pageOf(location) : false;
  const allDone = story ? story.steps.every((s) => s.done) : false;

  return (
    <Box
      ref={barRef}
      className="ojcp-bar"
      bg={OJCP.obsidian}
      c={OJCP.text}
      style={{
        fontFamily: OJCP.mono,
        borderBottom: "1px solid #28282f",
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}
    >
      <Text
        size="11px"
        ta="center"
        py={4}
        bg="#2a2208"
        c="#f0d08a"
        style={{ fontFamily: OJCP.sans }}
      >
        {boot.notice}
      </Text>
      <Group gap={0} px={{ base: "xs", sm: "md" }} wrap="nowrap">
        <Group gap={0} wrap="nowrap" style={{ overflowX: "auto", minWidth: 0, flex: 1 }}>
          <a
            href={`${boot.origins.home}/`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              paddingRight: 20,
              color: OJCP.text,
            }}
          >
            <img src={ojcpIcon} alt="OJCP" width={24} height={24} />
            <Text fw={700} size="sm" visibleFrom="sm">
              OJCP <span style={{ color: OJCP.gold }}>sandbox</span>
            </Text>
          </a>
          {TABS.map((t, i) => (
            <Tooltip key={t.tab} label={t.who} openDelay={300}>
              <a
                className="ojcp-tab"
                data-active={activeTab === t.tab}
                href={`${boot.origins[t.role]}/${t.path ?? ""}`}
                aria-label={t.label}
              >
                <span className="num">{i + 1}</span>
                <t.icon size={16} />
                <span className="label">{t.label}</span>
              </a>
            </Tooltip>
          ))}
        </Group>
        <Indicator
          label={story?.inbox.length ?? 0}
          size={16}
          offset={4}
          color="ojcpGold"
          disabled={!story?.inbox.length}
        >
          <Button
            variant="subtle"
            color="gray"
            size="xs"
            px={8}
            leftSection={<IconMail size={15} />}
            onClick={() => setInboxOpen(true)}
            aria-label="Jordan's inbox"
            styles={{ root: { color: OJCP.text }, section: { marginInlineEnd: 0 } }}
          >
            <Box component="span" visibleFrom="md" ml={6}>
              Jordan's inbox
            </Box>
          </Button>
        </Indicator>
        <Tooltip
          label="Rebuild the whole sandbox with new keys and start over at step 1"
          openDelay={300}
        >
          <Button
            variant="subtle"
            color="gray"
            size="xs"
            px={8}
            ml={4}
            leftSection={<IconRefresh size={15} />}
            loading={resetting}
            aria-label="Reset all"
            onClick={async () => {
              if (
                !confirm("Reset everything? Every party gets new keys and the story starts over.")
              )
                return;
              setResetting(true);
              await fetch("/_sandbox/lab/reset", { method: "POST" });
              location.href = `${boot.origins.hr}/`;
            }}
            styles={{ root: { color: OJCP.text }, section: { marginInlineEnd: 0 } }}
          >
            <Box component="span" visibleFrom="md" ml={6}>
              Reset all
            </Box>
          </Button>
        </Tooltip>
      </Group>
      {story && step && (
        <Group
          px={{ base: "xs", sm: "md" }}
          py={8}
          gap="sm"
          wrap="wrap"
          bg={OJCP.surface}
          style={{ borderTop: "1px solid #28282f", rowGap: 6 }}
        >
          <Badge
            variant="light"
            radius="sm"
            style={{ flexShrink: 0, color: OJCP.gold, background: "rgba(232,168,48,0.14)" }}
          >
            {allDone ? "Story complete" : `Step ${step.n} of ${story.steps.length}`}
          </Badge>
          <Box style={{ minWidth: 200, flex: 1 }}>
            <Text size="sm" fw={600} truncate>
              {allDone ? "You've seen the whole journey" : step.title}
            </Text>
            <Text size="xs" c={OJCP.muted} truncate>
              {allDone
                ? "Try what can go wrong under the hood, or reset the sandbox and start again."
                : step.detail}
            </Text>
          </Box>
          <Popover width={460} position="bottom-end" shadow="lg">
            <Popover.Target>
              <Button
                size="xs"
                variant="subtle"
                color="gray"
                leftSection={<IconListDetails size={15} />}
                styles={{ root: { color: OJCP.text } }}
              >
                All steps
              </Button>
            </Popover.Target>
            <Popover.Dropdown bg={OJCP.elevated} style={{ borderColor: "#3a3a46" }}>
              <ScrollArea.Autosize mah={480}>
                <StepList steps={story.steps} current={story.current} />
              </ScrollArea.Autosize>
            </Popover.Dropdown>
          </Popover>
          {!allDone &&
            (here || nextIsThisPage ? (
              <Badge
                variant="outline"
                style={{ flexShrink: 0, color: OJCP.gold, borderColor: OJCP.gold }}
              >
                {here ? "You're here" : "Use the button on this page"}
              </Badge>
            ) : (
              <Button
                component="a"
                href={step.href}
                size="xs"
                rightSection={<IconArrowRight size={15} />}
                style={{ flexShrink: 0, background: OJCP.gold, color: OJCP.obsidian }}
              >
                Next: {TABS.find((t) => t.tab === (tabOfHref(step.href) ?? step.tab))?.label}
              </Button>
            ))}
        </Group>
      )}
      <Drawer
        opened={inboxOpen}
        onClose={() => setInboxOpen(false)}
        position="right"
        title="Jordan's inbox"
        size="md"
      >
        <Text size="sm" c="dimmed" mb="md">
          The sandbox's stand-in for Jordan's email and text messages.
        </Text>
        <Inbox messages={story?.inbox ?? []} />
      </Drawer>
    </Box>
  );
}
