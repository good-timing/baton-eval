export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((v) => typeof v === "string");
}

export function overCodePoints(text: string, max: number): boolean {
  return text.length > max && Array.from(text).length > max;
}

/** `text` cut to `max` code points, as the Console counts characters; the same string when it fits. */
export function cutToCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

const UNSTORABLE = /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replaces NUL and lone surrogates, which the Console can't store, in every string and key. */
export function storable(value: unknown): unknown {
  if (typeof value === "string") return value.replace(UNSTORABLE, "\uFFFD");
  if (Array.isArray(value)) return value.map(storable);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [storable(k) as string, storable(v)]));
  return value;
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The first line of `text`, without control characters, so a printed field can't break a line a program reads. */
export function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.split(/[\n\r\u0085\u2028\u2029]/).map((line) => line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()).find((line) => line !== "") ?? "";
}

/** One word for a `key=value` field: spaces would shift the fields after it. */
export function oneWord(text: string): string {
  return oneLine(text).replace(/\s+/g, "_") || "-";
}
