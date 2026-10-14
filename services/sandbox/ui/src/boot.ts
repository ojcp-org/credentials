/** What the server tells the page: which party's origin it is on, and where the others are. */
export type Role =
  | "home"
  | "issuer"
  | "agent"
  | "acme"
  | "lookalike"
  | "ats"
  | "globex"
  | "attestA"
  | "attestB"
  | "lists"
  | "hr"
  | "wallet";

export interface Boot {
  role: Role;
  origins: Record<Role, string>;
  notice: string;
  candidate: { name: string; email: string };
}

declare global {
  interface Window {
    __SANDBOX__?: Boot;
  }
}

export const boot: Boot = window.__SANDBOX__ ?? {
  role: "home",
  origins: {} as Record<Role, string>,
  notice: "OJCP sandbox",
  candidate: { name: "Jordan Lee", email: "jordan@example.com" },
};

/** Same-origin JSON calls; errors carry the server's message. */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const field = (name: string): string | undefined => {
      if (typeof json !== "object" || json === null || !(name in json)) return undefined;
      const value: unknown = Reflect.get(json, name);
      return typeof value === "string" ? value : undefined;
    };
    throw new Error(field("error_description") ?? field("error") ?? "Something went wrong.");
  }
  return json as T;
}

export const host = (role: Role): string => new URL(boot.origins[role] ?? location.origin).host;
