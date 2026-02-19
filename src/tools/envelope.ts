/**
 * Standard response envelope for AOF tools.
 * Provides token-efficient compact mode while maintaining backward compatibility.
 */
export interface ToolResponseEnvelope {
  /** Always present, concise summary of the operation */
  summary: string;
  /** Full output (omitted in compact mode) */
  details?: string;
  /** Optional warnings */
  warnings?: string[];
  /** Optional metadata */
  meta?: {
    taskId?: string;
    status?: string;
    charCount?: number;
    blockerId?: string;
    updatedFields?: string[];
    [key: string]: unknown;
  };
}

/**
 * Wrap a response in the standard envelope format.
 */
export function wrapResponse(
  summary: string,
  details?: string,
  meta?: ToolResponseEnvelope['meta'],
  warnings?: string[],
): ToolResponseEnvelope {
  const envelope: ToolResponseEnvelope = { summary };
  
  if (details !== undefined) {
    envelope.details = details;
  }
  
  if (warnings && warnings.length > 0) {
    envelope.warnings = warnings;
  }
  
  if (meta) {
    envelope.meta = meta;
  }
  
  return envelope;
}

/**
 * Format a response for compact mode (summary only).
 */
export function compactResponse(
  summary: string,
  meta?: ToolResponseEnvelope['meta'],
): ToolResponseEnvelope {
  return wrapResponse(summary, undefined, meta);
}
