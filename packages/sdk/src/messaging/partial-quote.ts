import crypto from "node:crypto";

import type { PartialText } from "../api/types.js";

export type PartialQuoteResult = {
  resolved: string | null;
  fallback: boolean;
};

function nthIndexOf(
  text: string,
  value: string,
  occurrence: number,
  fromIndex = 0,
): number {
  if (!value || !Number.isInteger(occurrence) || occurrence < 0) return -1;
  let position = fromIndex;
  for (let current = 0; current <= occurrence; current++) {
    position = text.indexOf(value, position);
    if (position < 0) return -1;
    if (current < occurrence) position += value.length;
  }
  return position;
}

function hashQuote(text: string): string {
  return crypto.createHash("md5").update(text, "utf8").digest("hex");
}

function candidate(
  fullText: string,
  partial: PartialText,
  endSearchMode: "global" | "relative",
): string | null {
  const start = nthIndexOf(fullText, partial.start, partial.startindex);
  if (start < 0) return null;
  const end =
    endSearchMode === "global"
      ? nthIndexOf(fullText, partial.end, partial.endindex)
      : nthIndexOf(
          fullText,
          partial.end,
          partial.endindex,
          start + partial.start.length,
        );
  if (end < start) return null;
  return fullText.slice(start, end + partial.end.length);
}

/**
 * Resolve both observed interpretations of endindex. When quotemd5 is present
 * it disambiguates the protocol variants; without a hash, global indexes match
 * the examples supplied with the newer Weixin payload definition.
 */
export function resolvePartialQuote(
  fullText: string,
  partial: PartialText,
): PartialQuoteResult {
  if (!fullText || !partial.start || !partial.end) {
    return { resolved: null, fallback: true };
  }
  const candidates = [
    candidate(fullText, partial, "global"),
    candidate(fullText, partial, "relative"),
  ].filter(
    (value, index, all): value is string =>
      Boolean(value) && all.indexOf(value) === index,
  );

  if (!partial.quotemd5) {
    return candidates[0]
      ? { resolved: candidates[0], fallback: false }
      : { resolved: null, fallback: true };
  }
  const expected = partial.quotemd5.toLowerCase();
  const resolved =
    candidates.find((value) => hashQuote(value) === expected) ?? null;
  return { resolved, fallback: resolved === null };
}
