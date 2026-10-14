/**
 * Tab 3: Jordan's AI assistant, ChatGPT-style. Its replies carry live cards:
 * the permission it asks for, the jobs it found, the applications it made.
 * Wallet steps and legal terms are Jordan's to do; the assistant only links.
 */
import {
  Accordion,
  ActionIcon,
  Alert,
  Anchor,
  Avatar,
  Badge,
  Blockquote,
  Box,
  Button,
  Chip,
  Group,
  List,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  ThemeIcon,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowUp,
  IconBriefcase,
  IconCheck,
  IconExternalLink,
  IconFingerprint,
  IconInfoCircle,
  IconShieldCheck,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, boot } from "../boot.ts";

type Card =
  | { kind: "proposal" }
  | { kind: "permission" }
  | { kind: "jobs"; open: string[] }
  | { kind: "applications"; ids: string[] };

interface Message {
  id: number;
  role: "user" | "assistant";
  text: string;
  card?: Card;
}

interface Application {
  id: string;
  title: string;
  employer: string;
  recipient: string;
  provider: string;
  state: "sent" | "needs_you" | "not_sent";
  headline: string;
  detail: string;
  learned: string[];
  notLearned: string[];
  terms?: Array<{ title: string; statement: string }>;
  verification?: {
    id: string;
    url: string;
    ref: string;
    maskedContact?: string;
    purpose: string;
    asks: string[];
    withoutWallet: string;
  };
}

interface Chat {
  messages: Message[];
  suggestions: string[];
  usesModel: boolean;
  proposal: {
    jobs: string;
    places: string;
    pay: string;
    perEmployer: number;
    total: number;
    until: string;
  };
  permission: {
    jobs: string[];
    places: string[];
    arrangements: string[];
    pay: string;
    perEmployer: number;
    total: number;
    sent: number;
    until: string;
    employers: string;
    never: string[];
  } | null;
  cancelled: boolean;
  applications: Application[];
}

interface FeedItem {
  provider: string;
  site: string;
  job: {
    id: string;
    title: string;
    employer: string;
    place: string;
    arrangement: string;
    pay: string;
  };
  recipient: {
    name: string;
    verified: boolean;
    note: string;
    onBehalfOf?: { name: string; confirmed: boolean };
  };
  verdict: "can_apply" | "outside" | "unverified" | "applied" | "no_permission";
  reasons: string[];
}

const pill: Record<Application["state"], { color: string; label: string }> = {
  sent: { color: "teal", label: "Sent" },
  needs_you: { color: "orange", label: "Needs you" },
  not_sent: { color: "gray", label: "Held back" },
};

function ProposalCard({
  chat,
  act,
  latest,
}: {
  chat: Chat;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  /** Only the most recent proposal can still be acted on. */
  latest: boolean;
}) {
  const p = chat.proposal;
  if (!latest || chat.permission)
    return (
      <Badge
        color={chat.permission && latest ? "teal" : "gray"}
        variant="light"
        leftSection={<IconCheck size={12} />}
      >
        {chat.permission && latest ? "Permission given" : "Earlier request"}
      </Badge>
    );
  return (
    <Paper withBorder radius="lg" p="lg">
      <Text fw={700} mb="xs">
        Turn on Job search: what JobGPT would be allowed to do
      </Text>
      <List
        spacing={6}
        size="sm"
        icon={
          <ThemeIcon size={20} radius="xl" color="teal" variant="light">
            <IconCheck size={12} />
          </ThemeIcon>
        }
      >
        <List.Item>Jobs: {p.jobs}</List.Item>
        <List.Item>Where: {p.places}</List.Item>
        <List.Item>Pay: {p.pay}</List.Item>
        <List.Item>
          At most {p.perEmployer} applications per company, {p.total} in total, until {p.until}
        </List.Item>
        <List.Item>Only to employers whose identity I can verify</List.Item>
        <List.Item
          icon={
            <ThemeIcon size={20} radius="xl" color="red" variant="light">
              <IconX size={12} />
            </ThemeIcon>
          }
        >
          Never: agree to terms, answer equal-opportunity questions, accept an offer, or see your
          wallet
        </List.Item>
      </List>
      <Group mt="md">
        <Button
          onClick={() =>
            act(async () => {
              const { url } = await api<{ url: string }>("/api/mandate/start", {});
              location.href = url;
            })
          }
        >
          Approve in my wallet
        </Button>
        <Button variant="default" onClick={() => act(() => api("/api/mandate/auto", {}))}>
          Demo shortcut
        </Button>
      </Group>
      <Text size="xs" c="dimmed" mt="sm">
        Your wallet opens with exactly this, and you approve with Face ID. You can narrow any of it
        there; JobGPT can't widen it.
      </Text>
    </Paper>
  );
}

function PermissionCard({ chat }: { chat: Chat }) {
  const p = chat.permission;
  if (!p) return null;
  return (
    <Paper withBorder radius="lg" p="md" bg="#f8fafb">
      <Group gap="xs" mb={6}>
        <IconShieldCheck size={18} color="teal" />
        <Text fw={600} size="sm">
          Your permission, kept in your wallet
        </Text>
      </Group>
      <Text size="sm" c="dimmed">
        {p.jobs.join("; ")} · {p.places.join("; ")} · {p.arrangements.join(", ")} · {p.pay} · at
        most {p.perEmployer} per company, {p.total} in total · until {p.until}
      </Text>
    </Paper>
  );
}

function JobsCard({
  act,
  paused,
  offered,
}: {
  act: (fn: () => Promise<unknown>) => Promise<void>;
  paused: boolean;
  /** The jobs JobGPT could apply to when it posted this card. */
  offered: string[];
}) {
  const [feed, setFeed] = useState<FeedItem[]>();
  useEffect(() => {
    if (!paused) api<FeedItem[]>("/api/feed").then(setFeed);
  }, [paused]);
  if (paused)
    return (
      <Badge color="gray" variant="light">
        Paused: JobGPT has no permission right now
      </Badge>
    );
  if (!feed) return <Loader size="sm" />;
  // The card keeps the jobs it offered; a job applied to since says so.
  const byId = new Map(feed.map((f) => [f.job.id, f]));
  const listed = offered.flatMap((id) => byId.get(id) ?? []);
  const open = listed.filter((f) => f.verdict === "can_apply");
  const outside = feed.filter((f) => f.verdict === "outside");
  const unverified = feed.filter((f) => f.verdict === "unverified");
  const row = (f: FeedItem) => (
    <Group
      key={f.job.id}
      justify="space-between"
      wrap="nowrap"
      py={8}
      style={{ borderBottom: "1px solid #f1f3f5" }}
    >
      <Box style={{ minWidth: 0 }}>
        <Text size="sm" fw={600} truncate>
          {f.job.title}
        </Text>
        <Text size="xs" c="dimmed" truncate>
          {f.job.employer} · {f.job.place} · {f.job.arrangement} · {f.job.pay}
        </Text>
      </Box>
      {f.verdict === "applied" ? (
        <Badge color="gray" variant="light" style={{ flexShrink: 0 }}>
          {f.reasons[0] ?? "Handled"}
        </Badge>
      ) : f.recipient.verified ? (
        <Badge
          color="teal"
          variant="light"
          leftSection={<IconShieldCheck size={12} />}
          style={{ flexShrink: 0 }}
        >
          {f.recipient.onBehalfOf
            ? `${f.recipient.name} for ${f.recipient.onBehalfOf.name}`
            : f.recipient.name}
        </Badge>
      ) : (
        <Badge color="red" variant="light" style={{ flexShrink: 0 }}>
          Unverified site
        </Badge>
      )}
    </Group>
  );
  return (
    <Paper withBorder radius="lg" p="md">
      <Text fw={700} size="sm" mb={4}>
        {listed.length} jobs that fit what you allowed
      </Text>
      {listed.map(row)}
      <Accordion variant="contained" mt="sm" radius="md">
        {outside.length > 0 && (
          <Accordion.Item value="outside">
            <Accordion.Control>
              <Text size="sm">{outside.length} outside what you allowed</Text>
            </Accordion.Control>
            <Accordion.Panel>
              {outside.map((f) => (
                <Text size="xs" key={f.job.id} mb={6}>
                  <b>{f.job.title}</b> ({f.job.employer}): {f.reasons.join(" ")}
                </Text>
              ))}
            </Accordion.Panel>
          </Accordion.Item>
        )}
        {unverified.length > 0 && (
          <Accordion.Item value="unverified">
            <Accordion.Control>
              <Text size="sm">{unverified.length} on a site I couldn't verify</Text>
            </Accordion.Control>
            <Accordion.Panel>
              {[...new Map(unverified.map((f) => [f.site, f])).values()].map((f) => (
                <Text size="xs" key={f.site} mb={6}>
                  <b>{f.site}</b> ({f.job.employer}): {f.recipient.note} I won't send your details
                  there.
                </Text>
              ))}
            </Accordion.Panel>
          </Accordion.Item>
        )}
      </Accordion>
      {open.length > 0 && (
        <Button mt="md" onClick={() => act(() => api("/api/apply-all", {}))}>
          Apply to all {open.length}
        </Button>
      )}
    </Paper>
  );
}

function ApplicationRow({
  a,
  act,
  approve,
}: {
  a: Application;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  approve: (a: Application) => void;
}) {
  const s = pill[a.state];
  return (
    <Box py="sm" style={{ borderBottom: "1px solid #f1f3f5" }}>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Box style={{ minWidth: 0 }}>
          <Text size="sm" fw={600}>
            {a.title} · {a.employer}
          </Text>
          <Text size="xs" c="dimmed">
            {a.detail}
          </Text>
        </Box>
        <Badge color={s.color} variant="light" style={{ flexShrink: 0 }}>
          {a.state === "not_sent" ? a.headline : s.label}
        </Badge>
      </Group>
      {a.state === "needs_you" && a.verification && (
        <Paper mt="sm" p="md" radius="md" bg="#fff8f0" style={{ border: "1px solid #ffd8a8" }}>
          <Group gap="xs" mb={6}>
            <IconFingerprint size={18} />
            <Text fw={600} size="sm">
              {a.employer} asks you to confirm your work history
            </Text>
          </Group>
          <Text size="xs" c="dimmed">
            Asked by {a.recipient} · application{" "}
            <b style={{ fontFamily: "monospace" }}>{a.verification.ref}</b> ·{" "}
            {a.verification.maskedContact}
          </Text>
          <Text size="xs" c="dimmed" mt={4}>
            If anything here differs from what your wallet shows, trust your wallet: it checks who's
            asking itself.
          </Text>
          <Blockquote
            p="xs"
            mt="xs"
            color="orange"
            cite={`${a.employer}'s statement`}
            styles={{ root: { fontSize: 13 } }}
          >
            {a.verification.purpose}
          </Blockquote>
          <Group gap={6} mt="xs">
            <Text size="xs">Your wallet will be asked for:</Text>
            {a.verification.asks.map((x) => (
              <Badge key={x} size="sm" variant="outline" color="gray">
                {x}
              </Badge>
            ))}
          </Group>
          <Group mt="sm">
            <Button
              size="xs"
              component="a"
              href={a.verification.url}
              rightSection={<IconExternalLink size={14} />}
            >
              Open {a.employer}'s verification page
            </Button>
            <Button
              size="xs"
              variant="default"
              onClick={() => act(() => api("/api/verification/continue", { record: a.id }))}
            >
              I've done it, send the application
            </Button>
          </Group>
          <Text size="xs" c="dimmed" mt={6}>
            {a.verification.withoutWallet}
          </Text>
        </Paper>
      )}
      {a.state === "needs_you" && a.terms && (
        <Paper mt="sm" p="md" radius="md" bg="#fff8f0" style={{ border: "1px solid #ffd8a8" }}>
          <Text fw={600} size="sm">
            {a.terms.map((t) => t.title).join(", ")}
          </Text>
          <Text size="xs" c="dimmed">
            {a.terms.map((t) => t.statement).join(" ")}
          </Text>
          <Button size="xs" mt="sm" onClick={() => approve(a)}>
            Review on my phone
          </Button>
        </Paper>
      )}
      {a.learned.length > 0 && (
        <Accordion variant="default" chevronPosition="left" mt={4}>
          <Accordion.Item value="learned" style={{ border: 0 }}>
            <Accordion.Control px={0}>
              <Text size="xs" c="blue">
                What {a.employer} learned about you
              </Text>
            </Accordion.Control>
            <Accordion.Panel>
              <Group align="flex-start" grow>
                <List size="xs" spacing={2}>
                  {a.learned.map((x) => (
                    <List.Item key={x}>{x}</List.Item>
                  ))}
                </List>
                <List size="xs" spacing={2} icon={<IconX size={12} color="gray" />}>
                  {a.notLearned.map((x) => (
                    <List.Item key={x}>{x}</List.Item>
                  ))}
                </List>
              </Group>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
    </Box>
  );
}

function Sidebar({ chat }: { chat: Chat }) {
  const p = chat.permission;
  const count = (s: Application["state"]) => chat.applications.filter((a) => a.state === s).length;
  return (
    <Stack
      p="md"
      gap="lg"
      w={280}
      bg="#f9f9f9"
      style={{ borderRight: "1px solid #ececec", flexShrink: 0 }}
      visibleFrom="md"
    >
      <Group gap="xs">
        <ThemeIcon radius="xl" color="dark" size={30}>
          <IconSparkles size={17} />
        </ThemeIcon>
        <Box>
          <Text fw={700} size="sm">
            JobGPT
          </Text>
          <Text size="xs" c="dimmed">
            {chat.usesModel ? "Your AI assistant" : "Your AI assistant · scripted demo"}
          </Text>
        </Box>
      </Group>
      <Box>
        <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>
          Apps
        </Text>
        <Paper p="sm" radius="md" withBorder>
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" fw={600}>
              Job search
            </Text>
            <Badge size="xs" color={p ? "teal" : "gray"} variant="light">
              {p ? "On" : "Off"}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            Applies on OJCP career sites, with a permission you approve in your wallet.
          </Text>
          {p && (
            <>
              <Text size="xs" mt={6}>
                Until {p.until} · {p.sent} of {p.total} applications used
              </Text>
              <Anchor href={`${boot.origins.wallet}/#permissions`} size="xs">
                Manage or cancel in your wallet
              </Anchor>
            </>
          )}
          {!p && chat.cancelled && (
            <Text size="xs" c="orange" mt={6}>
              You cancelled this permission in your wallet.
            </Text>
          )}
        </Paper>
      </Box>
      <Box>
        <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>
          Applications
        </Text>
        {chat.applications.length === 0 ? (
          <Text size="sm" c="dimmed">
            None yet.
          </Text>
        ) : (
          <Stack gap={4}>
            <Text size="sm">{count("sent")} sent</Text>
            <Text
              size="sm"
              c={count("needs_you") ? "orange" : undefined}
              fw={count("needs_you") ? 600 : 400}
            >
              {count("needs_you")} need you
            </Text>
            <Text size="sm" c="dimmed">
              {count("not_sent")} held back
            </Text>
          </Stack>
        )}
      </Box>
      <Box style={{ flex: 1 }} />
      <Text size="xs" c="dimmed">
        JobGPT can't change what you allowed or see your wallet records. You can cancel its
        permission in your wallet at any time.
      </Text>
    </Stack>
  );
}

/** Below the md breakpoint the sidebar is hidden; this keeps its status in view. */
function StatusStrip({ chat }: { chat: Chat }) {
  const p = chat.permission;
  return (
    <Group
      hiddenFrom="md"
      px="md"
      py={8}
      gap="xs"
      wrap="nowrap"
      bg="#f9f9f9"
      style={{ borderBottom: "1px solid #ececec" }}
    >
      <Text size="sm" fw={600}>
        Job search
      </Text>
      <Badge size="xs" color={p ? "teal" : "gray"} variant="light">
        {p ? "On" : "Off"}
      </Badge>
      <Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
        {p
          ? `${p.sent} of ${p.total} used · until ${p.until}`
          : chat.cancelled
            ? "You cancelled it in your wallet"
            : ""}
      </Text>
      {p && (
        <Anchor href={`${boot.origins.wallet}/#permissions`} size="xs" style={{ flexShrink: 0 }}>
          Manage
        </Anchor>
      )}
    </Group>
  );
}

/**
 * Reveals JobGPT's new replies a few words at a time, one message after another,
 * like a model streaming tokens. Replies already seen in this tab appear at once.
 */
function useReveal(messages: Message[] | undefined) {
  const [shown, setShown] = useState<number>();
  const [typing, setTyping] = useState<{ id: number; chars: number }>();
  useEffect(() => {
    if (shown !== undefined || !messages) return;
    const last = messages.at(-1)?.id ?? 0;
    // With reduced motion, nothing types in.
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setShown(last);
    // Coming back from the wallet, whatever arrived meanwhile streams in. A new
    // tab shows the history at once and types only the latest reply; a reset
    // world (ids start again) starts from the greeting.
    const stored = sessionStorage.getItem("jobgpt:shown");
    const seen = stored === null ? (messages.at(-2)?.id ?? 0) : Number(stored);
    setShown(Number.isFinite(seen) && seen <= last ? seen : 0);
  }, [messages, shown]);
  useEffect(() => {
    if (shown !== undefined) sessionStorage.setItem("jobgpt:shown", String(shown));
  }, [shown]);
  useEffect(() => {
    if (!messages || shown === undefined || typing) return;
    const next = messages.find((m) => m.id > shown);
    if (!next) return;
    if (next.role === "user") {
      setShown(next.id);
      return;
    }
    const t = setTimeout(() => setTyping({ id: next.id, chars: 0 }), 400);
    return () => clearTimeout(t);
  }, [messages, shown, typing]);
  useEffect(() => {
    if (!typing || !messages) return;
    const m = messages.find((x) => x.id === typing.id);
    if (!m) return;
    if (typing.chars >= m.text.length) {
      const t = setTimeout(() => {
        setShown(m.id);
        setTyping(undefined);
      }, 300);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      const space = m.text.indexOf(" ", typing.chars + 1);
      setTyping({ id: m.id, chars: space < 0 ? m.text.length : space + 1 });
    }, 38);
    return () => clearTimeout(t);
  }, [typing, messages]);
  const pending = !!messages && shown !== undefined && messages.some((m) => m.id > shown);
  return { shown: shown ?? 0, typing, pending };
}

export function Assistant() {
  const [chat, setChat] = useState<Chat>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [phone, setPhone] = useState<Application>();
  const [sending, setSending] = useState<string>();
  const bottom = useRef<HTMLDivElement>(null);
  const reveal = useReveal(chat?.messages);

  const load = useCallback(
    () =>
      api<Chat>("/api/chat").then(setChat, (e: Error) =>
        setError(`JobGPT couldn't load: ${e.message}`),
      ),
    [],
  );
  useEffect(() => {
    void load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  const count = chat?.messages.length ?? 0;
  const typed = reveal.typing?.chars ?? 0;
  // Keep the newest text in view as messages arrive, stream in, or are sent.
  useEffect(() => {
    if (count || typed || sending) bottom.current?.scrollIntoView({ block: "end" });
  }, [count, typed, sending]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(undefined);
      try {
        await fn();
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  async function send(message: string) {
    const t = message.trim();
    if (!t) return;
    setText("");
    // Show the candidate's own message at once, as a chat app does.
    setSending(t);
    await act(() => api("/api/chat", { text: t }));
    setSending(undefined);
  }

  if (!chat)
    return error ? (
      <Alert m="xl" color="red" icon={<IconAlertTriangle />} title="Something went wrong">
        {error}
        <Button mt="sm" size="xs" variant="light" onClick={() => void load()}>
          Try again
        </Button>
      </Alert>
    ) : (
      <Loader m="xl" />
    );
  const byId = new Map(chat.applications.map((a) => [a.id, a]));
  const latestProposal = chat.messages.findLast((m) => m.card?.kind === "proposal")?.id;

  return (
    <Box style={{ display: "flex", height: "calc(100vh - var(--bar-h, 116px))" }} bg="white">
      <Sidebar chat={chat} />
      <Box style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <StatusStrip chat={chat} />
        <ScrollArea style={{ flex: 1 }}>
          <Stack maw={780} mx="auto" px="md" py="xl" gap="lg">
            {chat.messages.length <= 1 && (
              <Box ta="center" py="lg">
                <Title order={2}>What can I help with?</Title>
                <Text c="dimmed" size="sm">
                  I'm JobGPT. With the Job search app I can find roles and apply for you, within
                  limits you set.
                </Text>
              </Box>
            )}
            {chat.messages
              .filter((m) => m.id <= reveal.shown || m.id === reveal.typing?.id)
              .map((m) => {
                const chars = reveal.typing?.id === m.id ? reveal.typing.chars : undefined;
                return m.role === "user" ? (
                  <div key={m.id} className="chat-bubble-user">
                    <Text size="sm">{m.text}</Text>
                  </div>
                ) : (
                  <Group key={m.id} align="flex-start" wrap="nowrap" gap="sm">
                    <Avatar radius="xl" size={30} color="dark">
                      <IconSparkles size={16} />
                    </Avatar>
                    <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
                      <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                        {chars === undefined ? m.text : m.text.slice(0, chars)}
                        {chars !== undefined && <span className="caret" />}
                      </Text>
                      {chars !== undefined ? null : (
                        <>
                          {m.card?.kind === "proposal" && (
                            <ProposalCard chat={chat} act={act} latest={m.id === latestProposal} />
                          )}
                          {m.card?.kind === "permission" && <PermissionCard chat={chat} />}
                          {m.card?.kind === "jobs" && (
                            <JobsCard act={act} paused={!chat.permission} offered={m.card.open} />
                          )}
                          {m.card?.kind === "applications" && (
                            <Paper withBorder radius="lg" px="md" py={4}>
                              {m.card.ids
                                .map((id) => byId.get(id))
                                .filter((a): a is Application => a !== undefined)
                                // What needs Jordan goes last, next to where the chat scrolls to.
                                .sort(
                                  (x, y) =>
                                    Number(x.state === "needs_you") -
                                    Number(y.state === "needs_you"),
                                )
                                .map((a) => (
                                  <ApplicationRow key={a.id} a={a} act={act} approve={setPhone} />
                                ))}
                            </Paper>
                          )}
                        </>
                      )}
                    </Stack>
                  </Group>
                );
              })}
            {sending && (
              <div className="chat-bubble-user">
                <Text size="sm">{sending}</Text>
              </div>
            )}
            {(busy || (reveal.pending && !reveal.typing)) && (
              <Group gap="sm">
                <Avatar radius="xl" size={30} color="dark">
                  <IconSparkles size={16} />
                </Avatar>
                <Loader size="xs" type="dots" />
              </Group>
            )}
            <div ref={bottom} />
          </Stack>
        </ScrollArea>
        <Box px="md" pb="md" pt="xs">
          <Box maw={780} mx="auto">
            {error && (
              <Alert
                color="red"
                mb="xs"
                icon={<IconAlertTriangle />}
                withCloseButton
                onClose={() => setError(undefined)}
              >
                {error}
              </Alert>
            )}
            {chat.suggestions.length > 0 && !reveal.pending && !reveal.typing && !busy && (
              <Group gap={6} mb="xs">
                {chat.suggestions.map((s) => (
                  <Chip
                    key={s}
                    checked={false}
                    onChange={() => void send(s)}
                    disabled={busy}
                    size="sm"
                    variant="outline"
                  >
                    {s}
                  </Chip>
                ))}
              </Group>
            )}
            <Paper withBorder radius="xl" p={6} pl="md" shadow="xs">
              <Group wrap="nowrap" gap="xs">
                <Textarea
                  aria-label="Message JobGPT"
                  variant="unstyled"
                  autosize
                  minRows={1}
                  maxRows={5}
                  style={{ flex: 1 }}
                  placeholder={
                    chat.usesModel
                      ? "Message your assistant"
                      : "Message your assistant (or tap a suggestion)"
                  }
                  value={text}
                  onChange={(e) => setText(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send(text);
                    }
                  }}
                />
                <ActionIcon
                  size={34}
                  radius="xl"
                  color="dark"
                  disabled={busy || !text.trim()}
                  onClick={() => void send(text)}
                  aria-label="Send"
                >
                  <IconArrowUp size={18} />
                </ActionIcon>
              </Group>
            </Paper>
            <Group justify="center" gap={4} mt={6}>
              <IconInfoCircle size={12} color="gray" />
              <Text size="xs" c="dimmed">
                Sandbox: made-up employers.{" "}
                <Anchor href={`${boot.origins.home}/hood`} size="xs">
                  See what happens under the hood
                </Anchor>
              </Text>
            </Group>
          </Box>
        </Box>
      </Box>
      <Modal
        opened={phone !== undefined}
        onClose={() => setPhone(undefined)}
        centered
        withCloseButton={false}
        aria-label="Jordan's phone: approval request"
        radius={36}
        padding={0}
        size={360}
      >
        {phone?.terms && (
          <Stack p="xl" gap="md" bg="#f4f5f8">
            <Text size="xs" c="dimmed" ta="center">
              Jordan's phone · approval request
            </Text>
            <Group gap="xs">
              <IconBriefcase size={18} />
              <Text fw={700}>{phone.employer}</Text>
            </Group>
            <Text size="sm" c="dimmed">
              {phone.title}
            </Text>
            {phone.terms.map((t) => (
              <Paper key={t.title} withBorder p="md" radius="md">
                <Text fw={600} size="sm">
                  {t.title}
                </Text>
                <Text size="sm">{t.statement}</Text>
              </Paper>
            ))}
            <Text size="xs" c="dimmed">
              You agree for this one application only. Your assistant can't agree to terms for you.
            </Text>
            <Button
              onClick={() => {
                const a = phone;
                setPhone(undefined);
                void act(() => api("/api/approve", { record: a.id }));
              }}
            >
              Agree and send
            </Button>
            <Button variant="subtle" onClick={() => setPhone(undefined)}>
              Not now
            </Button>
          </Stack>
        )}
      </Modal>
    </Box>
  );
}
