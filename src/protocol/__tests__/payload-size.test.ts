/**
 * SEC-003: Payload size validation tests.
 * Ensures oversized protocol messages are rejected to prevent resource exhaustion.
 */
import { describe, expect, it, vi } from "vitest";
import { parseProtocolMessage, MAX_ENVELOPE_BYTES } from "../parsers.js";
import type { ProtocolLogger } from "../parsers.js";

function makeLogger(): ProtocolLogger & { calls: Array<{ type: string; payload?: Record<string, unknown> }> } {
  const calls: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  return {
    calls,
    log(type, _actor, opts) {
      calls.push({ type: type as string, payload: opts?.payload });
    },
  };
}

describe("SEC-003: payload size validation", () => {
  it("rejects string events exceeding MAX_ENVELOPE_BYTES", () => {
    const logger = makeLogger();
    const oversized = "x".repeat(MAX_ENVELOPE_BYTES + 1);
    const result = parseProtocolMessage(oversized, logger);

    expect(result).toBeNull();
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0].payload?.reason).toBe("payload_too_large");
  });

  it("rejects oversized string payloads nested in event objects", () => {
    const logger = makeLogger();
    const oversized = "x".repeat(MAX_ENVELOPE_BYTES + 1);
    const result = parseProtocolMessage({ payload: oversized }, logger);

    expect(result).toBeNull();
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0].payload?.reason).toBe("payload_too_large");
  });

  it("does not reject payloads under the size limit for size reasons", () => {
    const logger = makeLogger();
    const smallPayload = "x".repeat(100);
    parseProtocolMessage(smallPayload, logger);

    // May fail Zod validation, but should NOT fail for payload_too_large
    expect(logger.calls.every((c) => c.payload?.reason !== "payload_too_large")).toBe(true);
  });
});
