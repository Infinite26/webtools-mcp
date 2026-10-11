/**
 * HTML utilities for the webtools MCP server. Zero dependencies.
 *
 * Provides: entity decoding, tag-aware text/markdown extraction, link
 * collection, and DuckDuckGo "lite" result parsing. The extractor is a
 * single-pass tokenizer, not a DOM parser: it is lossy by design and tuned
 * for agent readability of ordinary pages, not rendering fidelity.
 */

/** Named HTML entities commonly found on real pages, beyond the XML five. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', copy: '\u00A9', reg: '\u00AE', trade: '\u2122', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201C', rdquo: '\u201D', bull: '\u2022', middot: '\u00B7',
  deg: '\u00B0', plusmn: '\u00B1', times: '\u00D7', divide: '\u00F7',
  frac12: '\u00BD', frac14: '\u00BC', frac34: '\u00BE', euro: '\u20AC',
  pound: '\u00A3', yen: '\u00A5', cent: '\u00A2', sect: '\u00A7',
  para: '\u00B6', laquo: '\u00AB', raquo: '\u00BB', larr: '\u2190',
  rarr: '\u2192', uarr: '\u2191', darr: '\u2193', harr: '\u2194',
  // Common Latin-1 accented letters seen in real content.
  eacute: '\u00E9', egrave: '\u00E8', ecirc: '\u00EA', euml: '\u00EB',
  agrave: '\u00E0', aacute: '\u00E1', acirc: '\u00E2', auml: '\u00E4',
  ugrave: '\u00F9', uacute: '\u00FA', ucirc: '\u00FB', uuml: '\u00FC',
  ograve: '\u00F2', oacute: '\u00F3', ocirc: '\u00F4', ouml: '\u00F6',
  igrave: '\u00EC', iacute: '\u00ED', icirc: '\u00EE', iuml: '\u00EF',
  ccedil: '\u00E7', ntilde: '\u00F1', szlig: '\u00DF', oslash: '\u00F8',
  aring: '\u00E5', aelig: '\u00E6',
};

const XML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

/**
 * Decode numeric and common named HTML entities to text.
 * Unknown entities pass through unchanged; NUL decodes to U+FFFD.
 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (raw, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return raw;
      }
      return String.fromCodePoint(code === 0 ? 0xfffd : code);
    }
    return XML_ENTITIES[body] ?? NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? raw;
  });
}

/** Remove markup tags, keeping inner text. */
export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

/**
 * Remove regions whose content never contributes readable text:
 * comments, doctype, and the bodies of script/style/noscript/template/
 * svg/iframe/head elements.
 */
export function stripInvisible(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!DOCTYPE[^>]*>/gi, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|head)(\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, ' ');
}

/** Tags whose close ends a block with a blank line after it. */
const BLOCK_GAP_2 = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre',
  'table', 'ul', 'ol', 'dl', 'figure', 'figcaption',
]);

/** Tags treated as a plain line break on open and close. */
const BLOCK_LINE = new Set([
  'div', 'section', 'article', 'nav', 'header', 'footer', 'aside', 'main',
  'form', 'fieldset', 'address', 'dt', 'dd', 'video', 'audio', 'canvas',
  'details', 'summary',
]);

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

/** Characters after which text attaches with no separating space (inline
 * markdown markers just emitted). */
const NO_SPACE_BEFORE = /^[\[(~*`!#\u2022|]$/;

export interface HtmlToTextOptions {
  /** Emit links as [text](url), headings as #, lists as bullets. Default true. */
  markdown?: boolean;
  /** Base URL used to resolve relative link/image targets. */
  baseUrl?: string;
}

interface ParsedTag {
  name: string;
  closing: boolean;
  attrs: Record<string, string>;
}

function parseTag(raw: string): ParsedTag | null {
  const body = raw.slice(1, -1);
  const closing = body.startsWith('/');
  const expr = closing ? body.slice(1) : body;
  const nameMatch = expr.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (!nameMatch) return null;
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(expr)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return { name: nameMatch[0].toLowerCase(), closing, attrs };
}

function resolveUrl(href: string, baseUrl?: string): string {
  try {
    return baseUrl ? new URL(href, baseUrl).toString() : href;
  } catch {
    return href;
  }
}

/**
 * Convert HTML to readable plain text or markdown. Structural tags become
 * line breaks; scripts/styles/comments are dropped; `<pre>` blocks are
 * preserved verbatim; entities are decoded. With `baseUrl`, markdown link
 * and image targets are resolved to absolute URLs.
 */
export function htmlToText(source: string, options: HtmlToTextOptions = {}): string {
  const markdown = options.markdown !== false;

  const titleMatch = source.match(/<title(\s[^>]*)?>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[2])).replace(/\s+/g, ' ').trim() : '';

  const html = stripInvisible(source);
  let buf = '';

  const atLineStart = (): boolean => buf.length === 0 || buf.endsWith('\n');
  const trailingNewlines = (): number => buf.length - buf.replace(/\n+$/, '').length;
  function gap(minNewlines: number): void {
    if (!buf && minNewlines > 0) return; // no leading blank lines
    if (buf && trailingNewlines() < minNewlines) buf += '\n'.repeat(minNewlines - trailingNewlines());
  }

  let pendingPrefix = '';
  let anchorHref: string | null = null; // one level of anchor nesting is tracked
  let cellOpen = false;
  let forceSpaceBeforeNextText = false;
  let i = 0;

  /** Insert one space when the buffer currently ends mid-word. */
  const sepIfWord = (): void => {
    if (buf && !atLineStart() && /[A-Za-z0-9]$/.test(buf)) buf += ' ';
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      emitText(html.slice(i));
      break;
    }
    if (lt > i) emitText(html.slice(i, lt));

    // Find the tag end, respecting quoted attribute values.
    let end = lt + 1;
    let quote: string | null = null;
    while (end < html.length) {
      const ch = html[end];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      end++;
    }
    if (end >= html.length) { i = html.length; break; } // unterminated tag: drop rest

    const tag = parseTag(html.slice(lt, end + 1));
    i = end + 1;
    if (!tag) continue;

    switch (tag.name) {
      case 'br':
        gap(1);
        continue;
      case 'hr':
        gap(2);
        if (markdown) buf += '---';
        gap(2);
        continue;
      case 'img': {
        const src = tag.attrs.src ?? tag.attrs['data-src'] ?? '';
        if (markdown && src) {
          sepIfWord();
          buf += `![${decodeEntities(tag.attrs.alt ?? '').trim()}](${resolveUrl(src, options.baseUrl)})`;
          forceSpaceBeforeNextText = true;
        } else if (tag.attrs.alt) {
          sepIfWord();
          buf += decodeEntities(tag.attrs.alt).trim();
          forceSpaceBeforeNextText = true;
        }
        continue;
      }
      case 'pre': {
        gap(2);
        const closeIdx = html.toLowerCase().indexOf('</pre', i);
        const raw = html.slice(i, closeIdx >= 0 ? closeIdx : html.length);
        i = closeIdx >= 0 ? html.indexOf('>', closeIdx) + 1 || html.length : html.length;
        const text = decodeEntities(raw.replace(/<\/?[a-zA-Z][^>]*>/g, ''));
        if (markdown) buf += '```\n' + text.replace(/\n$/, '') + '\n```';
        else buf += text;
        gap(2);
        continue;
      }
      default:
        break;
    }

    if (/^h[1-6]$/.test(tag.name)) {
      if (tag.closing) {
        gap(2);
      } else {
        gap(2);
        pendingPrefix = markdown ? '#'.repeat(Number(tag.name[1])) + ' ' : '';
        cellOpen = false;
      }
      continue;
    }

    switch (tag.name) {
      case 'p': case 'blockquote': case 'table': case 'figure':
        gap(2); // blank line around paragraph-level blocks
        cellOpen = false;
        continue;
      case 'li':
        if (tag.closing) { gap(1); }
        else { gap(1); pendingPrefix = markdown ? '- ' : '\u2022 '; }
        continue;
      case 'tr':
        gap(1);
        cellOpen = false;
        continue;
      case 'td': case 'th':
        if (tag.closing && cellOpen) { buf += ' | '; cellOpen = false; }
        else if (!tag.closing) cellOpen = true;
        continue;
      case 'a':
        if (!tag.closing) {
          const href = tag.attrs.href ?? '';
          if (markdown && href && !href.startsWith('javascript:')) {
            anchorHref = resolveUrl(href, options.baseUrl);
            sepIfWord();
            buf += '[';
          } else {
            anchorHref = null;
          }
        } else if (anchorHref) {
          buf += `](${anchorHref})`;
          anchorHref = null;
          forceSpaceBeforeNextText = true;
        }
        continue;
      case 'strong': case 'b':
        if (markdown) {
          if (tag.closing) { buf += '**'; forceSpaceBeforeNextText = true; }
          else { sepIfWord(); buf += '**'; }
        }
        continue;
      case 'em': case 'i':
        if (markdown) {
          if (tag.closing) { buf += '*'; forceSpaceBeforeNextText = true; }
          else { sepIfWord(); buf += '*'; }
        }
        continue;
      case 'code':
        if (markdown) {
          if (tag.closing) { buf += '`'; forceSpaceBeforeNextText = true; }
          else { sepIfWord(); buf += '`'; }
        }
        continue;
      default:
        if (BLOCK_GAP_2.has(tag.name)) { gap(2); cellOpen = false; continue; }
        if (BLOCK_LINE.has(tag.name) || VOID_TAGS.has(tag.name)) { gap(1); continue; }
        continue; // unknown/inline tags: drop markup, keep text
    }
  }

  function emitText(raw: string): void {
    const text = decodeEntities(raw).replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (pendingPrefix) { buf += pendingPrefix; pendingPrefix = ''; }
    else if (forceSpaceBeforeNextText) { buf += ' '; }
    else if (buf && !atLineStart() && !/\s$/.test(buf) && !NO_SPACE_BEFORE.test(buf.slice(-1))) buf += ' ';
    forceSpaceBeforeNextText = false;
    buf += text;
  }

  let result = buf;
  const firstLine = result.split('\n', 1)[0]?.trim() ?? '';
  const titleHeading = markdown ? `# ${title}` : title;
  if (title && firstLine !== title && firstLine !== titleHeading) {
    result = `${titleHeading}\n\n${result}`;
  }
  result = result
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ *\| *\n/g, '\n') // drop table-cell separators left dangling at end of a row
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return result;
}

export interface PageLink {
  url: string;
  text: string;
}

/**
 * Collect unique absolute links from a page in document order.
 * Skips javascript:/data:/mailto-style targets and empty anchors.
 */
export function collectLinks(source: string, baseUrl: string, limit = 300): PageLink[] {
  const cleaned = stripInvisible(source);
  const seen = new Map<string, string>();
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(cleaned)) !== null && seen.size < limit) {
    const attrs = parseTag(`<a ${m[1]}>`)?.attrs ?? {};
    const rawHref = attrs.href?.trim();
    if (!rawHref) continue;
    let url: URL;
    try {
      url = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    const key = url.toString();
    if (seen.has(key)) continue;
    const text = decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim().slice(0, 200);
    seen.set(key, text);
  }
  return [...seen].map(([url, text]) => ({ url, text }));
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Unwrap a DuckDuckGo redirect target (`//duckduckgo.com/l/?uddg=…`). */
function unwrapDdgUrl(href: string): string {
  try {
    const abs = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(abs, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : href;
  } catch {
    return href;
  }
}

/**
 * Parse a DuckDuckGo "lite" results page into title/url/snippet triples.
 * Returns whatever rows parsed; an empty array means the layout changed or
 * there were no hits.
 */
export function parseDdgLite(html: string): SearchResult[] {
  const cleaned = stripInvisible(html);
  const titles: Array<{ url: string; title: string }> = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(cleaned)) !== null) {
    const attrs = parseTag(`<a ${m[1]}>`)?.attrs ?? {};
    if (!/\bresult-link\b/.test(attrs.class ?? '')) continue;
    if (!attrs.href) continue;
    titles.push({
      url: unwrapDdgUrl(attrs.href),
      title: decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim(),
    });
  }
  const snippets: string[] = [];
  const snippetRe = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
  while ((m = snippetRe.exec(cleaned)) !== null) {
    if (!/\bresult-snippet\b/.test(m[1])) continue;
    snippets.push(decodeEntities(stripTags(m[2])).replace(/\s+/g, ' ').trim());
  }
  return titles.map((t, idx) => ({ ...t, snippet: snippets[idx] ?? '' }));
}
