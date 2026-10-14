/**
 * The salary grid (RFC 0008 §2.2): the floor never leaves the issuer and agent;
 * providers learn only a rung within about 6% of what the job already pays.
 */
import type { SalaryElement } from "./model.ts";

/** Mantissas ×100, about 6% apart. */
const MANTISSAS = [
  100, 106, 112, 118, 125, 132, 140, 150, 160, 170, 180, 190, 200, 212, 224, 236, 250, 265, 280,
  300, 315, 335, 355, 375, 400, 425, 450, 475, 500, 530, 560, 600, 630, 670, 710, 750, 800, 850,
  900, 950,
] as const;

function gridValue(mantissa: number, exponent: number): number {
  // mantissa/100 × 10^exponent, computed so values like 132000 and 31.5 are exact.
  const shift = exponent - 2;
  return shift >= 0 ? mantissa * 10 ** shift : mantissa / 10 ** -shift;
}

/** Grid values in [min, max], ascending. */
export function gridValuesBetween(min: number, max: number): number[] {
  if (!(min > 0) || !(max >= min)) throw new RangeError("invalid range");
  const out: number[] = [];
  for (
    let exponent = Math.floor(Math.log10(min)) - 1;
    exponent <= Math.ceil(Math.log10(max));
    exponent++
  ) {
    for (const m of MANTISSAS) {
      const v = gridValue(m, exponent);
      if (v >= min && v <= max) out.push(v);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export function isGridValue(value: number): boolean {
  return gridValuesBetween(value, value).length === 1;
}

/** The nearest grid values below and above `value`, for a consent screen's floor picker. */
export function nearestGridValues(value: number): { below?: number; above?: number } {
  const candidates = gridValuesBetween(value / 1.2, value * 1.2);
  const below = candidates.filter((v) => v <= value).at(-1);
  const above = candidates.find((v) => v >= value);
  return { ...(below === undefined ? {} : { below }), ...(above === undefined ? {} : { above }) };
}

/** Every rung from the floor to four times the floor (RFC 0008 §2.2). */
export function salaryRungs(floor: {
  value: number;
  currency: string;
  unitText: string;
}): SalaryElement[] {
  if (!isGridValue(floor.value))
    throw new RangeError(`salary floor ${floor.value} is not a grid value`);
  return gridValuesBetween(floor.value, floor.value * 4).map((at_least) => ({
    at_least,
    currency: floor.currency,
    unitText: floor.unitText as "HOUR" | "WEEK" | "MONTH" | "YEAR",
  }));
}

export interface PostedSalary {
  currency?: string | undefined;
  minValue?: number | undefined;
  unitText?: string | undefined;
}

/** A posting's low end, when it states one completely. */
export function comparableLowEnd(
  posted: PostedSalary | undefined,
): { currency: string; unitText: string; minValue: number } | null {
  if (!posted || typeof posted.minValue !== "number" || !posted.currency || !posted.unitText)
    return null;
  return {
    currency: posted.currency,
    unitText: posted.unitText.toUpperCase(),
    minValue: posted.minValue,
  };
}
