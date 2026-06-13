import { htmlToText } from 'html-to-text';

export function stripHtml(html) {
  return htmlToText(html || '', {
    wordwrap: false,
    selectors: [
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'img', format: 'skip' }
    ]
  }).replace(/\r\n?/g, '\n').trim();
}

export function normalizeText(input) {
  return String(input || '')
    .normalize('NFKC')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function createSearchText(input) {
  const text = normalizeText(input).toLowerCase();
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || [];
  const grams = [];

  for (let i = 0; i < cjk.length; i += 1) {
    grams.push(cjk[i]);
    if (i + 1 < cjk.length) grams.push(`${cjk[i]}${cjk[i + 1]}`);
  }

  return `${text} ${grams.join(' ')}`.trim();
}

export function createFtsQuery(input) {
  const text = normalizeText(input).toLowerCase();
  if (!text) return '';

  const asciiTerms = text.match(/[a-z0-9_]+/g) || [];
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || [];
  const terms = [...asciiTerms];

  if (cjk.length === 1) terms.push(cjk[0]);
  for (let i = 0; i < cjk.length - 1; i += 1) {
    terms.push(`${cjk[i]}${cjk[i + 1]}`);
  }

  return [...new Set(terms)]
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' AND ');
}

export function excerpt(text, needle, maxLength = 160) {
  const source = normalizeText(text).replace(/\s+/g, ' ');
  const query = normalizeText(needle);
  const index = query ? source.toLowerCase().indexOf(query.toLowerCase()) : -1;
  const start = Math.max(0, index === -1 ? 0 : index - 60);
  const end = Math.min(source.length, start + maxLength);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < source.length ? '...' : '';
  return `${prefix}${source.slice(start, end)}${suffix}`;
}

export function splitTxtIntoSections(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const sections = [];
  let current = { title: '正文', content: [] };
  const headingPattern = /^(第[一二三四五六七八九十百千万零〇\d]+[章节回卷部篇集].{0,40}|Chapter\s+\d+.{0,60})$/i;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && headingPattern.test(trimmed) && current.content.join('\n').trim()) {
      sections.push({ title: current.title, text: current.content.join('\n').trim() });
      current = { title: trimmed, content: [] };
    } else if (trimmed && headingPattern.test(trimmed) && current.title === '正文' && current.content.length === 0) {
      current.title = trimmed;
    } else {
      current.content.push(line);
    }
  }

  const finalText = current.content.join('\n').trim();
  if (finalText) sections.push({ title: current.title, text: finalText });
  return sections.length ? sections : [{ title: '正文', text: normalized.trim() }];
}
