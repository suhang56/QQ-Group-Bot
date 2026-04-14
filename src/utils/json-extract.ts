/**
 * Extract a JSON object or array from a Claude response that may be wrapped in
 * markdown code fences and/or followed by prose. Returns parsed value or null.
 */
export function extractJson<T = unknown>(raw: string): T | null {
  if (!raw) return null;
  let text = raw.trim();

  // Match a markdown fence ANYWHERE in the text (Claude often adds leading prose)
  // \n? makes the newlines around the content optional for fences without trailing newline
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    text = fenceMatch[1]!.trim();
  }

  // Find first { or [ and last matching closer (greedy)
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  let start = -1;
  let openChar = '';
  let closeChar = '';
  if (firstObj === -1 && firstArr === -1) return null;
  if (firstObj === -1 || (firstArr !== -1 && firstArr < firstObj)) {
    start = firstArr; openChar = '['; closeChar = ']';
  } else {
    start = firstObj; openChar = '{'; closeChar = '}';
  }

  // Walk forward counting brackets, respecting strings and escapes
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;

  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
