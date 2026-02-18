export function serializeTags(tags?: string[] | null): string | null {
  if (!tags || tags.length === 0) {
    return null;
  }

  return JSON.stringify(tags);
}

export function parseTags(tags: string | null): string[] | null {
  if (!tags) {
    return null;
  }

  try {
    const parsed = JSON.parse(tags) as unknown;
    if (Array.isArray(parsed) && parsed.every((tag) => typeof tag === "string")) {
      return parsed;
    }
  } catch (error) {
    return [tags];
  }

  return [tags];
}
