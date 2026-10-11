import { describe, expect, test } from 'bun:test';
import { collectLinks, decodeEntities, htmlToText, parseDdgLite } from './lib.ts';

describe('decodeEntities', () => {
  test('named and numeric entities', () => {
    expect(decodeEntities('a &amp; b &lt;tag&gt; &#39;quoted&#x27;')).toBe("a & b <tag> 'quoted'");
    expect(decodeEntities('café caf&eacute; caf\u00e9 &#65;&#x42;')).toBe('café café café AB');
  });

  test('unknown entities pass through, NUL becomes replacement char', () => {
    expect(decodeEntities('&notanentity; &amp')).toBe('&notanentity; &amp');
    expect(decodeEntities('&#0;')).toBe('\uFFFD');
  });
});

describe('htmlToText markdown mode', () => {
  const page = `<!DOCTYPE html>
<html><head><title>Test Page</title>
<script>var x = "<p>never visible</p>";</script>
<style>.a { color: red }</style></head>
<body>
<!-- a comment -->
<h1>Main&nbsp;Heading</h1>
<p>Intro with <a href="/docs/guide">the guide</a> and <strong>bold</b> text.
<ul><li>first</li><li>second</li></ul>
<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>
<pre>const x = 1 &lt; 2</pre>
<img src="/logo.png" alt="Logo">
</body></html>`;

  const md = htmlToText(page, { markdown: true, baseUrl: 'https://example.com/base/' });

  test('extracts title as top heading', () => {
    expect(md.startsWith('# Test Page\n\n')).toBe(true);
  });

  test('drops script/style/comment content entirely', () => {
    expect(md).not.toContain('never visible');
    expect(md).not.toContain('color: red');
    expect(md).not.toContain('comment');
  });

  test('converts headings, links, lists, emphasis', () => {
    expect(md).toContain('# Main Heading'); // &nbsp; collapses to a plain space
    expect(md).toContain('with [the guide](https://example.com/docs/guide) and');
    expect(md).toContain('**bold** text');
    expect(md).toContain('- first');
    expect(md).toContain('- second');
  });

  test('renders table rows on separate lines with cell separators', () => {
    expect(md).toContain('A | B');
    expect(md).toContain('1 | 2');
  });

  test('preserves pre content verbatim, decoded, fenced', () => {
    expect(md).toContain('```\nconst x = 1 < 2\n```');
  });

  test('markdown image reference with resolved absolute URL', () => {
    expect(md).toContain('![Logo](https://example.com/logo.png)');
  });

  test('text mode keeps link text but not bracket syntax', () => {
    const text = htmlToText(page, { markdown: false, baseUrl: 'https://example.com/' });
    expect(text).toContain('the guide');
    expect(text).not.toContain('](');
    expect(text).toContain('• first');
  });
});

describe('collectLinks', () => {
  const base = 'https://example.com/dir/page';
  const html = `<a href="other">Relative</a>
<a href="https://else.where/x?q=1#frag">Absolute</a>
<a href="javascript:void(0)">Bad</a>
<a href="/top">Top</a>
<a name="anchor-only">NoHref</a>
<a href="other">Duplicate</a>`;

  test('resolves relative URLs, dedupes, skips non-http schemes', () => {
    const links = collectLinks(html, base);
    const urls = links.map((l) => l.url);
    expect(urls).toContain('https://example.com/dir/other');
    expect(urls).toContain('https://else.where/x?q=1'); // fragment stripped
    expect(urls).toContain('https://example.com/top');
    expect(urls.filter((u) => u === 'https://example.com/dir/other').length).toBe(1);
    expect(urls.some((u) => u.startsWith('javascript'))).toBe(false);
  });

  test('keeps anchor text decoded', () => {
    expect(collectLinks('<a href="/x">Tom &amp; Jerry</a>', base)[0]?.text).toBe('Tom & Jerry');
  });
});

describe('parseDdgLite', () => {
  const ddg = `<html><body><table>
<tr><td><a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2F">Bun — The Fast Toolkit</a></td></tr>
<tr><td class='result-snippet'>Bun is an all-in-one JavaScript runtime.</td></tr>
<tr><td><a class="result-link" href="https://example.com/direct">Direct Link</a></td></tr>
<tr><td class="result-snippet">Second snippet here</td></tr>
</table></body></html>`;

  test('parses titles, unwraps redirect URLs, aligns snippets', () => {
    const results = parseDdgLite(ddg);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: 'Bun — The Fast Toolkit',
      url: 'https://bun.sh/',
      snippet: 'Bun is an all-in-one JavaScript runtime.',
    });
    expect(results[1]!.url).toBe('https://example.com/direct');
  });

  test('empty input yields no results', () => {
    expect(parseDdgLite('<html><body>nothing</body></html>')).toEqual([]);
  });
});
