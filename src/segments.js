const MAX_SEGMENTS = 16;

// Prompt Guard scores a short injected sentence far higher than the same sentence diluted in a longer listing.
export function injectionSegments(texts) {
  const segments = [];
  for (const text of texts) {
    const trimmed = text?.trim();
    if (!trimmed) continue;
    segments.push(trimmed);
    const sentences = trimmed.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
    if (sentences.length > 1) segments.push(...sentences);
  }
  return [...new Set(segments)].slice(0, MAX_SEGMENTS);
}
