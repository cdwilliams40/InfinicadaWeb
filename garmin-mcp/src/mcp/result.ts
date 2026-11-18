import type { CallToolResult } from "@modelcontextprotocol/server";
import { GarminApiError } from "../garmin/client";

/**
 * Upper bound for one tool result, in characters (~25k tokens). Larger results
 * crowd out the conversation and are cut by most MCP clients anyway.
 */
export const MAX_RESULT_CHARS = 100_000;

export interface JsonResultOptions {
  /** A line for the model, shown before the data (e.g. what was left out). */
  note?: string;
  /** Top-level keys to remove from every object in the result, such as bulky sample arrays. */
  omit?: readonly string[];
}

/** Serialize data compactly: no nulls, no omitted keys, size-capped. */
export function jsonResult(data: unknown, options: JsonResultOptions = {}): CallToolResult {
  if (data === null || data === undefined) {
    return text(
      "Garmin returned no data for this request: the feature may not be in use, the watch was not worn, or the data has not synced yet.",
    );
  }

  const cleaned = clean(data, new Set(options.omit ?? []), 0);
  const notes = options.note ? [options.note] : [];
  let body = JSON.stringify(cleaned);

  if (body.length > MAX_RESULT_CHARS) {
    if (!Array.isArray(cleaned)) {
      return error(
        `The result is ${body.length.toLocaleString("en")} characters, above the ${MAX_RESULT_CHARS.toLocaleString("en")} limit. Request a shorter date range, a lower limit, or leave sample/detail options off.`,
      );
    }
    const kept = fitArray(cleaned);
    body = JSON.stringify(kept);
    notes.push(
      `Truncated: showing the first ${kept.length} of ${cleaned.length} items to stay within the size limit. Request the rest separately (a later date range or the next page), or use a summary/aggregated option if the tool has one.`,
    );
  }

  return { content: [...notes.map((note) => ({ type: "text" as const, text: note })), { type: "text", text: body }] };
}

export function text(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

/** A tool-level error: returned to the model (not thrown) so it can correct course. */
export function error(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run a tool body, turning failures into actionable tool errors. */
export async function safely(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof GarminApiError) return error(cause.message);
    console.error(JSON.stringify({ message: "tool failed", error: String(cause) }));
    return error("Unexpected error while talking to Garmin. Retry; if it keeps failing, check the Worker logs.");
  }
}

function clean(value: unknown, omit: Set<string>, depth: number): unknown {
  if (Array.isArray(value)) return value.map((item) => clean(item, omit, depth + 1));
  // Float noise such as 0.7950000166893006 costs tokens and adds nothing.
  if (typeof value === "number" && !Number.isInteger(value)) return Number(value.toPrecision(7));
  if (value === null || typeof value !== "object" || value instanceof Date) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    // Omitted keys apply to the response objects themselves, not to arbitrary nested data.
    if (depth <= 2 && omit.has(key)) continue;
    result[key] = typeof item === "number" ? readableTimestamp(key, item) : clean(item, omit, depth + 1);
  }
  return result;
}

/** 2001-09-09 in epoch milliseconds: smaller numbers are not timestamps. */
const MIN_EPOCH_MS = 1e12;

/**
 * Garmin sends many timestamps as epoch milliseconds, which models misread.
 * `…GMT` fields become UTC ISO strings; `…Local` fields hold wall-clock time
 * encoded as UTC, so they become ISO strings without an offset.
 */
function readableTimestamp(key: string, value: number): unknown {
  if (value < MIN_EPOCH_MS || !Number.isInteger(value)) return clean(value, new Set(), 0);
  if (/(GMT|Gmt)$/.test(key) || key === "beginTimestamp") return new Date(value).toISOString();
  if (/Local$/.test(key)) return new Date(value).toISOString().slice(0, -1);
  return value;
}

function fitArray(items: unknown[]): unknown[] {
  const kept: unknown[] = [];
  let size = 2;
  for (const item of items) {
    size += JSON.stringify(item).length + 1;
    if (size > MAX_RESULT_CHARS) break;
    kept.push(item);
  }
  return kept;
}
