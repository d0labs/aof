/**
 * Protocol message parsers — extracted from router.ts for modularity.
 */

import { ProtocolEnvelope } from "../schemas/protocol.js";
import type { ProtocolEnvelope as ProtocolEnvelopeType } from "../schemas/protocol.js";
import type { EventType } from "../schemas/event.js";

const PROTOCOL_PREFIX = "AOF/1 ";

export interface ProtocolLogger {
  log(
    type: EventType,
    actor: string,
    opts?: {
      taskId?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<unknown> | unknown;
}

export function parseProtocolMessage(
  event: unknown,
  logger?: ProtocolLogger,
): ProtocolEnvelopeType | null {
  const candidate = extractPayload(event);

  if (candidate && typeof candidate === "object") {
    if ((candidate as { protocol?: unknown }).protocol === "aof") {
      return validateEnvelope(candidate, logger);
    }
    return null;
  }

  if (typeof candidate === "string") {
    const trimmed = candidate.trim();

    if (trimmed.startsWith(PROTOCOL_PREFIX)) {
      const jsonText = trimmed.slice(PROTOCOL_PREFIX.length).trim();
      return parseJsonEnvelope(jsonText, logger, "AOF/1 prefix");
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return parseJsonEnvelope(trimmed, logger, "json");
    }
  }

  return null;
}

function extractPayload(event: unknown): unknown {
  if (event && typeof event === "object") {
    const record = event as Record<string, unknown>;
    if (record.payload !== undefined) return record.payload;
    if (record.message !== undefined) return record.message;
    if (record.content !== undefined) return record.content;
  }

  return event;
}

function parseJsonEnvelope(
  jsonText: string,
  logger?: ProtocolLogger,
  source?: string,
): ProtocolEnvelopeType | null {
  const parsed = safeParseJson(jsonText);
  if (!parsed.success) {
    void logger?.log("protocol.message.rejected", "system", {
      payload: {
        reason: "invalid_json",
        source,
        error: parsed.error,
      },
    });
    return null;
  }

  return validateEnvelope(parsed.value, logger);
}

function validateEnvelope(
  value: unknown,
  logger?: ProtocolLogger,
): ProtocolEnvelopeType | null {
  const result = ProtocolEnvelope.safeParse(value);
  if (!result.success) {
    void logger?.log("protocol.message.rejected", "system", {
      payload: {
        reason: "invalid_envelope",
        errors: result.error.issues.map((issue) => issue.message),
      },
    });
    return null;
  }

  return result.data;
}

function safeParseJson(value: string):
  | { success: true; value: unknown }
  | { success: false; error: string } {
  try {
    return { success: true, value: JSON.parse(value) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
