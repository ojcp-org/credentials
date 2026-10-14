/**
 * O*NET-SOC 2019 classification (RFC 0009 §1) and hierarchy containment for
 * standing-mandate scope (RFC 0008 §2.2) and `filters.occupational_category`.
 */
import data from "./soc-2019.json" with { type: "json" };

export const ONET_SOC_2019 = "https://www.onetcenter.org/taxonomy/2019/list.html";

type Node = { t: string; p: string | null };
const structure = data.structure as Record<string, Node>;
const occupations = data.occupations as Record<string, string>;

const CODE = /^\d{2}-\d{4}(\.\d{2})?$/;

/** Maps an O*NET `.00` code to its SOC detailed occupation; other codes are unchanged. */
function node(code: string): string {
  return code.endsWith(".00") ? code.slice(0, 7) : code;
}

/** True if `code` is a listed O*NET-SOC 2019 code (RFC 0009 §1.1). */
export function isListedOccupation(code: string): boolean {
  return Object.hasOwn(occupations, code);
}

/** True if `code` is a SOC 2018 group or occupation, or a listed O*NET-SOC code. */
export function isKnownCode(code: string): boolean {
  return CODE.test(code) && (isListedOccupation(code) || Object.hasOwn(structure, node(code)));
}

export function title(code: string): string | undefined {
  return occupations[code] ?? structure[node(code)]?.t;
}

/** Residual "All Other" occupations match a scope only when disclosed exactly (RFC 0008 §2.2). */
export function isResidual(code: string): boolean {
  return /All Other$/.test(title(code) ?? "");
}

/** The code and its ancestors, nearest first, in normalized (SOC) form. */
export function lineage(code: string): string[] {
  const chain: string[] = [];
  let current: string | null = node(code);
  while (current !== null) {
    const entry: Node | undefined = structure[current];
    if (!entry) break;
    chain.push(current);
    current = entry.p;
  }
  return chain;
}

/**
 * True if `scopeCode` (any level) contains `jobCode` in the published hierarchy.
 * Not a string-prefix test: broad occupation 29-1210 contains 29-1221. A residual
 * job code is contained only by itself (`15-1299.00` or its SOC form `15-1299`).
 */
export function contains(scopeCode: string, jobCode: string): boolean {
  if (!isKnownCode(scopeCode) || !isListedOccupation(jobCode)) return false;
  if (isResidual(jobCode)) return node(scopeCode) === node(jobCode);
  return lineage(jobCode).includes(node(scopeCode));
}
