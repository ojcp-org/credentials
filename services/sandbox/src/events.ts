/**
 * Sandbox-wide state that a demo needs to see and steer: one clock every role
 * reads, a timeline of what each party did and learned, and an inbox standing
 * in for email and SMS.
 */
import type { Messenger } from "@ojcp/issuer";

/** One clock for every role, so a demo can jump ahead (revocation timing, expiry). */
export class SandboxClock {
  #offset = 0;
  now(): number {
    return Math.floor(Date.now() / 1000) + this.#offset;
  }
  advance(seconds: number): void {
    this.#offset += seconds;
  }
  reset(): void {
    this.#offset = 0;
  }
  get offset(): number {
    return this.#offset;
  }
}

export type Actor =
  | "agent"
  | "issuer"
  | "provider"
  | "attester"
  | "lists"
  | "candidate"
  | "hr"
  | "wallet"
  | "sandbox";

export interface SandboxEvent {
  id: number;
  /** Sandbox time (Unix seconds). */
  at: number;
  actor: Actor;
  /** Which origin acted, e.g. `acme.sandbox.ojcp.dev`. */
  where: string;
  title: string;
  outcome: "ok" | "refused" | "info";
  /** Structured detail: what was sent, disclosed or decided. */
  detail?: Record<string, unknown>;
}

export class EventBus {
  readonly #events: SandboxEvent[] = [];
  readonly #listeners = new Set<(e: SandboxEvent) => void>();
  #next = 1;
  readonly #clock: SandboxClock;

  constructor(clock: SandboxClock) {
    this.#clock = clock;
  }

  emit(event: Omit<SandboxEvent, "id" | "at">): SandboxEvent {
    const e = { ...event, id: this.#next++, at: this.#clock.now() };
    this.#events.push(e);
    if (this.#events.length > 2000) this.#events.shift();
    for (const listener of this.#listeners) listener(e);
    return e;
  }

  since(id: number): SandboxEvent[] {
    return this.#events.filter((e) => e.id > id);
  }

  subscribe(listener: (e: SandboxEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  clear(): void {
    this.#events.length = 0;
  }
}

export interface InboxMessage {
  /** Who sent it, as the candidate would see it in their mail app. */
  from: string;
  to: string;
  subject: string;
  text: string;
  at: number;
}

/** A party that sends email or text messages. */
export interface Sender {
  actor: Actor;
  /** Its origin's host. */
  where: string;
  /** The sender name shown to the candidate. */
  name: string;
}

/** Stands in for email and SMS: every party's messages land here, visible to the candidate. */
export class Inbox {
  readonly messages: InboxMessage[] = [];
  readonly #events: EventBus;
  readonly #clock: SandboxClock;

  constructor(events: EventBus, clock: SandboxClock) {
    this.#events = events;
    this.#clock = clock;
  }

  /** A messenger that sends as one party. */
  as(sender: Sender): Messenger {
    return {
      send: async (to, message) => {
        const address = "email" in to ? to.email : to.phone;
        this.messages.push({ from: sender.name, to: address, ...message, at: this.#clock.now() });
        // Anyone can trigger messages on a public sandbox; keep the latest only.
        if (this.messages.length > 200) this.messages.shift();
        this.#events.emit({
          actor: sender.actor,
          where: sender.where,
          title: `Message to ${address}: ${message.subject}`,
          outcome: "info",
          detail: { text: message.text },
        });
      },
    };
  }

  latestCode(to: string): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      const code = m && m.to === to ? m.text.match(/code is (\d{6})/)?.[1] : undefined;
      if (code) return code;
    }
    return undefined;
  }
}
