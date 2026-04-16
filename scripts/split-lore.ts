/**
 * One-time migration script: split monolithic lore file into per-member files.
 *
 * Usage: npx tsx scripts/split-lore.ts [groupId]
 * Default groupId: 958751334
 *
 * Reads data/lore/{groupId}.md, splits by ### headers under "## 常驻群友",
 * extracts aliases from header parentheses and content patterns,
 * outputs to data/groups/{groupId}/lore/_overview.md + per-member .md files.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const groupId = process.argv[2] ?? '958751334';
const lorePath = path.join('data', 'lore', `${groupId}.md`);

if (!existsSync(lorePath)) {
  console.error(`Lore file not found: ${lorePath}`);
  process.exit(1);
}

const content = readFileSync(lorePath, 'utf8');

// Split into lines for processing
const lines = content.split('\n');

interface MemberSection {
  header: string;
  body: string;
  aliases: string[];
  fileName: string;
}

// Find the "## 常驻群友" section and its ### sub-sections
let inMemberSection = false;
let overviewLines: string[] = [];
let memberSections: MemberSection[] = [];
let currentHeader = '';
let currentBodyLines: string[] = [];
let pastMemberSection = false;
let afterMemberContent: string[] = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i]!;

  if (line.startsWith('## 常驻群友')) {
    inMemberSection = true;
    // Everything before this (including the # title and intro) is overview
    continue;
  }

  if (!inMemberSection && !pastMemberSection) {
    overviewLines.push(line);
    continue;
  }

  // Check if we've hit the next ## section or a --- separator (end of 常驻群友)
  if (inMemberSection && (/^## /.test(line) && !line.startsWith('## 常驻群友') || line.trim() === '---')) {
    // Flush current member
    if (currentHeader) {
      memberSections.push(buildMemberSection(currentHeader, currentBodyLines));
      currentHeader = '';
      currentBodyLines = [];
    }
    inMemberSection = false;
    pastMemberSection = true;
    afterMemberContent.push(line);
    continue;
  }

  if (pastMemberSection) {
    afterMemberContent.push(line);
    continue;
  }

  // Inside 常驻群友: look for ### headers
  if (line.startsWith('### ')) {
    if (currentHeader) {
      memberSections.push(buildMemberSection(currentHeader, currentBodyLines));
    }
    currentHeader = line;
    currentBodyLines = [];
    continue;
  }

  currentBodyLines.push(line);
}

// Flush last member if still in section
if (currentHeader) {
  memberSections.push(buildMemberSection(currentHeader, currentBodyLines));
}

function buildMemberSection(header: string, bodyLines: string[]): MemberSection {
  const body = bodyLines.join('\n').trim();
  const aliases = extractAliases(header, body);
  const fileName = deriveFileName(header, aliases);
  return { header, body, aliases, fileName };
}

/**
 * Extract aliases from the header and body text.
 * Header patterns: ### emoji Name（alias1/alias2/alias3）
 * Also looks for QQ IDs (numeric strings 5-12 digits) in body.
 */
function extractAliases(header: string, body: string): string[] {
  const aliases = new Set<string>();

  // Strip ### and emoji prefix
  let cleaned = header.replace(/^###\s*/, '').replace(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]/gu, '').trim();

  // Extract ALL parenthesized groups: 名前（alias1/alias2）（alias3）（alias4/alias5）
  const allParens = [...cleaned.matchAll(/[（(]([^）)]+)[）)]/g)];
  if (allParens.length > 0) {
    for (const pm of allParens) {
      const inside = pm[1]!;
      for (const a of inside.split(/[/、]/)) {
        const t = a.trim();
        if (t) aliases.add(t);
      }
    }
    // Also add the name part before first parenthesis
    const nameBefore = cleaned.slice(0, cleaned.indexOf(allParens[0]![0]!)).trim();
    if (nameBefore) {
      // Handle location prefixes like [TX] or [CA]
      const withoutBracket = nameBefore.replace(/^\[[^\]]+\]\s*/, '').trim();
      if (withoutBracket) aliases.add(withoutBracket);
      // Add the bracket prefix as-is too for matching
      if (nameBefore !== withoutBracket) aliases.add(nameBefore);
    }
  } else {
    // No parentheses — the whole cleaned header is the name
    const withoutBracket = cleaned.replace(/^\[[^\]]+\]\s*/, '').trim();
    if (withoutBracket) aliases.add(withoutBracket);
  }

  // Extract QQ IDs from body (5-12 digit numbers that look like QQ IDs)
  const qqIds = body.match(/\b\d{5,12}\b/g);
  if (qqIds) {
    for (const id of qqIds) {
      aliases.add(id);
    }
  }

  // Look for **bold** names in the body that might be alternate references
  // Pattern: names in list items like "- **Name**："
  const boldNames = body.match(/\*\*([^*]+)\*\*/g);
  if (boldNames) {
    for (const bold of boldNames) {
      const name = bold.replace(/\*\*/g, '').trim();
      // Only short names (likely person names, not phrases)
      if (name.length <= 20 && !name.includes('：') && !name.includes('最新记录')) {
        aliases.add(name);
      }
    }
  }

  return [...aliases].filter(a => a.length > 0);
}

/**
 * Derive a filesystem-safe filename from header/aliases.
 * Prefers short Chinese/English name from aliases.
 */
function deriveFileName(header: string, aliases: string[]): string {
  // Try to extract the primary name from the header directly
  // Pattern: ### emoji [location] PrimaryName（aliases...）
  let cleaned = header.replace(/^###\s*/, '').replace(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D]/gu, '').trim();
  // Remove location prefix [XX]
  cleaned = cleaned.replace(/^\[[^\]]+\]\s*/, '').trim();
  // Take just the name before first parenthesis
  const beforeParen = cleaned.replace(/[（(].*/s, '').trim();

  // Pick the shortest alias that's a reasonable filename, but prefer beforeParen
  const candidates = [
    beforeParen,
    ...aliases.filter(a => a.length <= 15 && !/^\d+$/.test(a) && !/^\[/.test(a)),
  ].filter(a => a.length > 0 && a.length <= 20);

  let name = candidates[0] ?? aliases[0] ?? 'unknown';

  // Sanitize for filesystem
  name = name.replace(/[<>:"/\\|?*\s！？。，]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

  if (!name) name = 'unknown';
  return name;
}

// Output directory
const outputDir = path.join('data', 'groups', groupId, 'lore');
mkdirSync(outputDir, { recursive: true });

// Write _overview.md: the intro text + everything after 常驻群友 (梗/黑话, 常聊话题, etc.)
const overviewContent = [
  overviewLines.join('\n').trim(),
  '',
  '---',
  '',
  afterMemberContent.join('\n').trim(),
].join('\n');

writeFileSync(path.join(outputDir, '_overview.md'), overviewContent, 'utf8');
console.log(`Written: _overview.md (${Buffer.byteLength(overviewContent)} bytes)`);

// Track used filenames to avoid collisions
const usedNames = new Set<string>();

for (const section of memberSections) {
  let fileName = section.fileName;
  // Handle collision
  if (usedNames.has(fileName)) {
    let i = 2;
    while (usedNames.has(`${fileName}_${i}`)) i++;
    fileName = `${fileName}_${i}`;
  }
  usedNames.add(fileName);

  const frontmatter = [
    '---',
    `aliases: [${section.aliases.map(a => `"${a.replace(/"/g, '\\"')}"`).join(', ')}]`,
    '---',
    '',
  ].join('\n');

  const fileContent = `${frontmatter}${section.header}\n${section.body}\n`;
  const filePath = path.join(outputDir, `${fileName}.md`);
  writeFileSync(filePath, fileContent, 'utf8');
  console.log(`Written: ${fileName}.md (${section.aliases.length} aliases, ${Buffer.byteLength(fileContent)} bytes)`);
}

console.log(`\nDone: ${memberSections.length} member files + _overview.md written to ${outputDir}`);
