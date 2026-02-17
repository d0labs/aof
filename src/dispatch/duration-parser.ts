/**
 * Parse duration string (e.g., "1h", "30m", "2h") to milliseconds.
 * 
 * Supported formats:
 * - "1h", "2h", etc. → hours
 * - "30m", "90m", etc. → minutes
 * 
 * @param duration - Duration string to parse
 * @returns milliseconds or null if invalid format
 * 
 * @example
 * ```typescript
 * parseDuration("1h")  // 3600000
 * parseDuration("30m") // 1800000
 * parseDuration("abc") // null
 * ```
 */
export function parseDuration(duration: string): number | null {
  // Match format: digits + unit (m or h)
  const match = duration.match(/^(\d+)([mh])$/);
  if (!match) return null;
  
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  
  // Reject zero or negative values
  if (value <= 0) return null;
  
  if (unit === "m") return value * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  
  return null;
}
