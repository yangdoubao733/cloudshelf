import AdmZip from 'adm-zip';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { stripHtml } from './text.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  removeNSPrefix: true,
  parseTagValue: false
});

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return value['#text'] || '';
}

function dirname(posixPath) {
  const dir = path.posix.dirname(posixPath);
  return dir === '.' ? '' : dir;
}

function joinPosix(base, target) {
  return path.posix.normalize(path.posix.join(base, target)).replace(/^\/+/, '');
}

function readXml(zip, entryName) {
  const entry = zip.getEntry(entryName);
  if (!entry) return null;
  return parser.parse(entry.getData().toString('utf8'));
}

function findOpfPath(zip) {
  const container = readXml(zip, 'META-INF/container.xml');
  const rootfiles = asArray(container?.container?.rootfiles?.rootfile);
  return rootfiles[0]?.['@_full-path'] || null;
}

function findCoverHref(metadata, manifestItems) {
  const meta = asArray(metadata?.meta);
  const coverId = meta.find((item) => item?.['@_name'] === 'cover')?.['@_content'];
  const item = manifestItems.find((candidate) => {
    const properties = candidate?.['@_properties'] || '';
    return candidate?.['@_id'] === coverId || properties.split(/\s+/).includes('cover-image');
  });
  return item?.['@_href'] || '';
}

function findNavItem(manifestItems) {
  return manifestItems.find((item) => {
    const properties = item?.['@_properties'] || '';
    return properties.split(/\s+/).includes('nav');
  });
}

function findNcxItem(pkg, manifestItems) {
  const tocId = pkg?.spine?.['@_toc'];
  return manifestItems.find((item) => item?.['@_id'] === tocId)
    || manifestItems.find((item) => (item?.['@_media-type'] || '').includes('dtbncx'));
}

function extractNavPoints(node, items = []) {
  if (!node || typeof node !== 'object') return items;
  const children = Array.isArray(node) ? node : Object.values(node);
  for (const child of children) {
    if (!child || typeof child !== 'object') continue;
    const href = child.a?.['@_href'] || child.a?.[0]?.['@_href'] || child['@_href'] || '';
    const label = textValue(child.a) || textValue(child.span) || textValue(child.text) || '';
    if (href && label) items.push({ title: label.trim(), href });
    extractNavPoints(child.ol || child.navPoint || child, items);
  }
  return items;
}

function parseEpub3Nav(zip, opfDir, manifestItems) {
  const navItem = findNavItem(manifestItems);
  if (!navItem?.['@_href']) return [];
  const nav = readXml(zip, joinPosix(opfDir, navItem['@_href']));
  const navs = asArray(nav?.html?.body?.nav);
  const toc = navs.find((item) => {
    const type = item?.['@_epub:type'] || item?.['@_type'] || '';
    return type.split(/\s+/).includes('toc');
  }) || navs[0];
  return extractNavPoints(toc?.ol || toc).filter((item) => item.title && item.href);
}

function parseEpub2Ncx(zip, opfDir, pkg, manifestItems) {
  const ncxItem = findNcxItem(pkg, manifestItems);
  if (!ncxItem?.['@_href']) return [];
  const ncx = readXml(zip, joinPosix(opfDir, ncxItem['@_href']));
  const points = [];

  function walk(navPoints) {
    for (const point of asArray(navPoints)) {
      const title = textValue(point?.navLabel?.text).trim();
      const href = point?.content?.['@_src'] || '';
      if (title && href) points.push({ title, href });
      walk(point?.navPoint);
    }
  }

  walk(ncx?.ncx?.navMap?.navPoint);
  return points;
}

function normalizeHref(href) {
  return String(href || '').split('#')[0];
}

export function parseEpub(filePath) {
  const zip = new AdmZip(filePath);
  const opfPath = findOpfPath(zip);
  if (!opfPath) throw new Error('无法找到 EPUB package 文件');

  const opf = readXml(zip, opfPath);
  const pkg = opf?.package;
  const metadata = pkg?.metadata || {};
  const manifestItems = asArray(pkg?.manifest?.item);
  const spineItems = asArray(pkg?.spine?.itemref);
  const opfDir = dirname(opfPath);

  const title = textValue(metadata.title) || '未命名 EPUB';
  const authors = asArray(metadata.creator).map(textValue).filter(Boolean);
  const language = textValue(metadata.language);
  const publisher = textValue(metadata.publisher);
  const description = stripHtml(textValue(metadata.description));
  const coverHref = findCoverHref(metadata, manifestItems);
  const coverPath = coverHref ? joinPosix(opfDir, coverHref) : '';
  const coverEntry = coverPath ? zip.getEntry(coverPath) : null;
  const cover = coverEntry
    ? {
        mime: manifestItems.find((item) => item?.['@_href'] === coverHref)?.['@_media-type'] || 'image/jpeg',
        data: coverEntry.getData()
      }
    : null;

  const manifestById = new Map(manifestItems.map((item) => [item?.['@_id'], item]));
  const sections = [];

  for (const itemref of spineItems) {
    const item = manifestById.get(itemref?.['@_idref']);
    if (!item?.['@_href']) continue;
    const mediaType = item['@_media-type'] || '';
    if (!mediaType.includes('html') && !mediaType.includes('xhtml')) continue;
    const entryName = joinPosix(opfDir, item['@_href']);
    const entry = zip.getEntry(entryName);
    if (!entry) continue;
    const html = entry.getData().toString('utf8');
    const text = stripHtml(html);
    if (text) {
      sections.push({
        title: item['@_id'] || `章节 ${sections.length + 1}`,
        href: item['@_href'],
        text
      });
    }
  }

  const sectionIndexByHref = new Map(sections.map((section, index) => [normalizeHref(section.href), index]));
  const rawToc = [
    ...parseEpub3Nav(zip, opfDir, manifestItems),
    ...parseEpub2Ncx(zip, opfDir, pkg, manifestItems)
  ];
  const seenToc = new Set();
  const toc = rawToc
    .map((item) => {
      const href = normalizeHref(item.href);
      const sectionIndex = sectionIndexByHref.get(href);
      return sectionIndex == null ? null : { title: item.title, href: item.href, sectionIndex };
    })
    .filter(Boolean)
    .filter((item) => {
      const key = `${item.sectionIndex}:${item.title}`;
      if (seenToc.has(key)) return false;
      seenToc.add(key);
      return true;
    });

  return {
    metadata: {
      title,
      authors,
      language,
      publisher,
      description
    },
    sections,
    toc: toc.length ? toc : sections.map((section, index) => ({ title: section.title, href: section.href, sectionIndex: index })),
    cover,
    opfPath
  };
}
