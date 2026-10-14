/**
 * The package's one structural guard. It proves only that a value is a plain
 * object; anything consumed field by field is parsed with a zod schema instead.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
