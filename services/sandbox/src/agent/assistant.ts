/**
 * The candidate's assistant, as a chat. Each reply can carry a card that the
 * UI renders from live state: the permission it proposes, the jobs it found,
 * the applications it made. Scripted by default; with a model configured, free
 * text goes to the model, which drives the same functions. Neither ever holds a
 * credential or sees a wallet record.
 */
import type { SandboxAgent } from "./agent.ts";
import type { CandidateView } from "./candidate.ts";
import type { LlmSession } from "./llm.ts";

export type Card =
  | { kind: "proposal" }
  | { kind: "permission" }
  | { kind: "jobs" }
  | { kind: "applications"; ids: string[] };

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  card?: Card;
}

export const FIRST_ASK =
  "Find data science jobs in New York, hybrid or remote, paying at least $125k, and apply for me.";

export class Assistant {
  readonly messages: ChatMessage[] = [];
  readonly #view: CandidateView;
  readonly #agent: SandboxAgent;
  readonly #llm: LlmSession | undefined;
  #next = 1;
  #busy = false;

  constructor(agent: SandboxAgent, view: CandidateView, llm: LlmSession | undefined) {
    this.#agent = agent;
    this.#view = view;
    this.#llm = llm;
    this.#say(
      "Hi Jordan, I'm JobGPT. Ask me anything. For job hunting, my Job search app can find roles on career sites that support OJCP and apply for you, within limits you set and only where I can confirm who runs the site.",
    );
  }

  get usesModel(): boolean {
    return this.#llm !== undefined;
  }

  get asked(): boolean {
    return this.messages.some((m) => m.role === "user");
  }

  #say(text: string, card?: Card): void {
    this.messages.push({ id: this.#next++, role: "assistant", text, ...(card ? { card } : {}) });
  }

  async #hasPermission(): Promise<boolean> {
    return (await this.#agent.store.batches()).some((b) => !b.revoked);
  }

  /** Short replies the candidate can tap, for where the conversation is. */
  async suggestions(): Promise<string[]> {
    if (!this.asked) return [FIRST_ASK];
    if (!(await this.#hasPermission())) return [];
    const feed = await this.#view.feed();
    const open = feed.filter((f) => f.verdict === "can_apply").length;
    const out: string[] = [];
    if (open > 0) out.push(`Apply to the ${open} that fit`);
    if (this.#view.applications.length > 0) out.push("How are my applications going?");
    return out;
  }

  async send(text: string): Promise<void> {
    if (this.#busy) throw new Error("One moment, still working on the last request.");
    this.#busy = true;
    try {
      this.messages.push({ id: this.#next++, role: "user", text });
      await this.#reply(text);
    } finally {
      this.#busy = false;
    }
  }

  async #reply(text: string): Promise<void> {
    const t = text.toLowerCase();
    if (!(await this.#hasPermission())) {
      this.#say(
        "I can do that with the Job search app. First I need your permission, and you don't give it to me: you approve it in your wallet, which records exactly what I may do. Employers check it every time I apply. Here's what I'd ask for; you can narrow any of it in your wallet.",
        { kind: "proposal" },
      );
      return;
    }
    if (/^apply to the \d+ that fit/.test(t) || (/\bapply\b/.test(t) && !this.#llm)) {
      await this.applyAll();
      return;
    }
    if (/how are|status|applications/.test(t) && !this.#llm) {
      const ids = this.#view.applications.map((a) => a.id);
      this.#say(
        ids.length ? "Here's where everything stands." : "I haven't applied anywhere yet.",
        ids.length ? { kind: "applications", ids } : undefined,
      );
      return;
    }
    if (this.#llm) {
      const before = new Set(this.#view.applications.map((a) => a.id));
      const reply = await this.#llm.send(text);
      const fresh = this.#view.applications.filter((a) => !before.has(a.id)).map((a) => a.id);
      this.#say(reply, fresh.length ? { kind: "applications", ids: fresh } : undefined);
      return;
    }
    this.#say(
      "With the Job search app I can search career sites, apply where your permission allows, and tell you how your applications are going. Try one of the suggestions below.",
    );
  }

  /** Called when the permission service hands the candidate back with a permission. */
  async onPermission(): Promise<void> {
    const summary = await this.#view.summary();
    this.#say(
      `Thank you. You approved my permission in your wallet, until ${String(summary?.until ?? "")}. I can't change what you allowed, and you can cancel it there at any time. I looked at four career sites. Here's what I found.`,
      { kind: "permission" },
    );
    const feed = await this.#view.feed();
    const open = feed.filter((f) => f.verdict === "can_apply").length;
    this.#say(
      `${open} jobs fit what you allowed, at employers whose identity I could confirm. Want me to apply to them?`,
      { kind: "jobs" },
    );
  }

  async applyAll(): Promise<void> {
    const records = await this.#view.autoApply();
    const sent = records.filter((r) => r.state === "sent").length;
    const needs = records.filter((r) => r.state === "needs_you");
    const verify = needs.filter((r) => r.verification).length;
    const terms = needs.filter((r) => r.terms).length;
    const parts = [`I sent ${sent} application${sent === 1 ? "" : "s"}.`];
    if (verify)
      parts.push(
        `${verify === 1 ? "One employer asks" : `${verify} employers ask`} you to confirm your work history with your wallet. That's yours to do on their page: I never see your records.`,
      );
    if (terms)
      parts.push(
        `${terms === 1 ? "One application has" : `${terms} have`} terms only you can agree to.`,
      );
    const skipped = records.length - sent - needs.length;
    if (skipped) parts.push(`I held back on ${skipped}, and say why below.`);
    this.#say(parts.join(" "), { kind: "applications", ids: records.map((r) => r.id) });
  }

  async continueVerification(recordId: string): Promise<void> {
    const record = await this.#view.continueVerification(recordId);
    this.#say(
      record.state === "sent"
        ? record.workHistory === "deferred"
          ? `You chose not to use your wallet, so I sent your application for ${record.title} without it. ${record.employer} will check your work history its own way after you apply; choosing that doesn't count against you.`
          : `${record.employer} confirmed your work history straight from your wallet, so I sent your application for ${record.title}.`
        : record.verification
          ? `${record.employer} hasn't received your confirmation yet. Finish on their page, then tell me.`
          : `${record.employer} didn't accept the application: ${record.detail}`,
      { kind: "applications", ids: [record.id] },
    );
  }

  /** The agent saw its credentials revoked: the candidate cancelled in their wallet. */
  onCancelled(): void {
    this.#say(
      "Your permission was cancelled in your wallet, so I've stopped applying for you. Applications I already sent stay with those employers. Ask me again whenever you want to give a new permission.",
    );
  }

  async approveTerms(recordId: string): Promise<void> {
    const record = await this.#view.approve(recordId);
    this.#say(
      record.state === "sent"
        ? `You agreed on your phone, for this one application, and I sent it to ${record.employer}.`
        : `${record.employer} didn't accept it: ${record.detail}`,
      { kind: "applications", ids: [record.id] },
    );
  }
}
