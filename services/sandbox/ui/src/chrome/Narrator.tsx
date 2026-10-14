/**
 * Narration: as things happen anywhere in the sandbox, a short plain-English
 * line slides in at the corner of every party's page. It shows what happens
 * behind the scenes (who checked what, what was shared, what was refused)
 * without leaving the page you're on. Only moments the server marks with
 * `say` appear here; "Under the hood" has the full record.
 */
import { ActionIcon, Box, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import {
  IconBriefcase,
  IconBuildingSkyscraper,
  IconCertificate,
  IconMessageChatbot,
  IconUser,
  IconVolume,
  IconVolumeOff,
  IconWallet,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { boot } from "../boot.ts";
import { OJCP } from "../theme.ts";

interface Narrated {
  id: number;
  at: number;
  actor: string;
  where: string;
  outcome: "ok" | "refused" | "info";
  say?: string;
}

interface Toast extends Narrated {
  say: string;
  /** When it appeared here, in page time, for its countdown. */
  shown: number;
  /** How far its countdown had run when it arrived on this page. */
  spent: number;
}

const WHO: Record<string, { label: string; icon: typeof IconWallet; color: string }> = {
  agent: { label: "JobGPT", icon: IconMessageChatbot, color: "#4dabf7" },
  wallet: { label: "Your wallet", icon: IconWallet, color: "#748ffc" },
  candidate: { label: "You", icon: IconUser, color: "#f783ac" },
  hr: { label: "ExamplePeople (HR)", icon: IconBuildingSkyscraper, color: "#38d9a9" },
  provider: { label: "Employer", icon: IconBriefcase, color: "#ffa94d" },
  attester: { label: "Attester", icon: IconCertificate, color: "#69db7c" },
  lists: { label: "Trust list", icon: IconCertificate, color: "#69db7c" },
};

const OUTCOME: Record<Narrated["outcome"], string> = {
  ok: "#40c057",
  refused: "#fa5252",
  info: OJCP.gold,
};

/** How long a line stays, by its length: long enough to read. */
const lifetime = (say: string) => Math.min(9000, 3500 + say.length * 45);
const MAX_SHOWN = 4;
const MUTED = "sandbox:narration-off";

export function Narrator() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTED) === "1");
  const hovering = useRef(false);

  useEffect(() => {
    if (muted) return;
    let live = true;
    // Undefined until the first load. Each page is a fresh load on its own origin
    // (a redirect, a link to the wallet), so the first load picks up the lines
    // still within their reading time, with their countdown carried on.
    let since: number | undefined;
    let world: string | undefined;
    const load = async () => {
      const page = await fetch(`/_sandbox/events?since=${since ?? 0}`)
        .then((r) => r.json() as Promise<{ world: string; now: number; events: Narrated[] }>)
        .catch(() => undefined);
      if (!live || !page) return;
      // A reset built a new world, whose ids start again: narrate it from its start.
      if (world !== undefined && page.world !== world) {
        world = page.world;
        since = 0;
        return;
      }
      world = page.world;
      const first = since === undefined;
      since = Math.max(since ?? 0, ...page.events.map((e) => e.id));
      const said = page.events.filter(
        (e): e is Narrated & { say: string } => typeof e.say === "string",
      );
      // Sandbox time is in seconds, the same clock as events' `at`.
      const fresh = first
        ? said
            .map((e) => {
              const spent = Math.max(0, (page.now - e.at) * 1000);
              return { ...e, shown: Date.now() - spent, spent };
            })
            .filter((e) => e.spent < lifetime(e.say))
        : said.map((e) => ({ ...e, shown: Date.now(), spent: 0 }));
      if (fresh.length) setToasts((t) => [...t, ...fresh].slice(-MAX_SHOWN));
    };
    void load();
    const t = setInterval(load, 1200);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [muted]);

  // Retire each line after its time, unless the reader is hovering the stack.
  useEffect(() => {
    if (toasts.length === 0) return;
    const t = setInterval(() => {
      if (hovering.current) return;
      const now = Date.now();
      setToasts((list) => list.filter((x) => now - x.shown < lifetime(x.say)));
    }, 500);
    return () => clearInterval(t);
  }, [toasts.length]);

  const toggle = () => {
    const next = !muted;
    localStorage.setItem(MUTED, next ? "1" : "0");
    setMuted(next);
    if (next) setToasts([]);
  };

  return (
    <Box
      className="narrator"
      // On the assistant, stay clear of the message box at the bottom.
      data-above-composer={boot.role === "agent"}
      onMouseEnter={() => {
        hovering.current = true;
      }}
      onMouseLeave={() => {
        hovering.current = false;
        // Give the reader a moment after leaving.
        setToasts((list) => list.map((x) => ({ ...x, shown: Date.now() - 1500 })));
      }}
    >
      <Stack gap={8} align="flex-end" aria-live="polite" aria-label="What's happening">
        {toasts.map((t) => {
          const who = WHO[t.actor] ?? { label: t.where, icon: IconCertificate, color: OJCP.gold };
          return (
            <Paper
              key={t.id}
              className="narration"
              radius="md"
              p="sm"
              pl="md"
              style={{
                borderLeft: `3px solid ${OUTCOME[t.outcome]}`,
                ["--life" as string]: `${lifetime(t.say)}ms`,
                // A line carried over from the previous page resumes its countdown.
                ["--life-spent" as string]: `-${t.spent}ms`,
              }}
            >
              <Group gap={8} wrap="nowrap" align="flex-start">
                <Box
                  style={{
                    flexShrink: 0,
                    width: 26,
                    height: 26,
                    borderRadius: 13,
                    display: "grid",
                    placeItems: "center",
                    background: `${who.color}22`,
                    color: who.color,
                  }}
                >
                  <who.icon size={15} />
                </Box>
                <Box style={{ minWidth: 0, flex: 1 }}>
                  <Group gap={6} justify="space-between" wrap="nowrap">
                    <Text
                      size="11px"
                      fw={700}
                      c={who.color}
                      tt="uppercase"
                      style={{ letterSpacing: 0.4 }}
                    >
                      {who.label}
                      <Text span size="11px" c={OJCP.muted} fw={400} tt="none" ml={6}>
                        {t.where}
                      </Text>
                    </Text>
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      color="gray"
                      aria-label="Dismiss"
                      onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))}
                    >
                      <IconX size={12} />
                    </ActionIcon>
                  </Group>
                  <Text size="sm" c={OJCP.text} mt={2} style={{ lineHeight: 1.4 }}>
                    {t.say}
                  </Text>
                </Box>
              </Group>
              <div className="narration-life" />
            </Paper>
          );
        })}
        <Tooltip
          label={muted ? "Show what's happening behind the scenes" : "Hide narration"}
          position="left"
          openDelay={300}
        >
          <ActionIcon
            radius="xl"
            size="lg"
            variant="filled"
            onClick={toggle}
            aria-label={muted ? "Turn narration on" : "Turn narration off"}
            style={{
              background: OJCP.obsidian,
              color: muted ? OJCP.muted : OJCP.gold,
              border: "1px solid #3a3a46",
            }}
          >
            {muted ? <IconVolumeOff size={17} /> : <IconVolume size={17} />}
          </ActionIcon>
        </Tooltip>
      </Stack>
    </Box>
  );
}
