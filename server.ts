#!/usr/bin/env bun
/**
 * webtools — zero-dependency MCP stdio server giving an agent website
 * interaction tools: fetch/read pages, search the web, list links, issue
 * generic HTTP requests, and download files.
 *
 * Wire protocol: newline-delimited JSON-RPC 2.0 (MCP stdio transport).
 * stdout carries protocol messages only; diagnostics go to stderr.
 *
 * Run: bun server.ts
 */

import { collectLinks, htmlToText, parseDdgLite } from './lib.ts';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_CHARS_CAP = 80_000;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const LATEST_PROTOCOL_VERSION = '2025-06-18';

function log(message: string): void {
  console.error(`[webtools] ${message}`);
}

/** Truncate long text to `max`, appending a visible marker when cut. */
function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n\n[… truncated ${text.length - max} characters; raise maxLength or narrow the request …]`,
    truncated: true,
  };
}

class ToolInputError extends Error { }

function reqString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ToolInputError(`"${key}" is required and must be a non-empty string`);
  }
  return value.trim();
}

function optEnum<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T): T {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new ToolInputError(`"${key}" must be one of: ${allowed.join(', ')}`);
}

function optInt(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ToolInputError(`"${key}" must be an integer between ${min} and ${max}`);
  }
  return Math.round(n);
}

/** Validate and normalize an http(s) URL from tool input. */
function httpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolInputError(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolInputError(`only http/https URLs are supported, got ${url.protocol}`);
  }
  return url;
}

async function fetchText(url: string, timeoutMs: number): Promise<{ res: Response; body: string }> {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  const declared = res.headers.get('content-length');
  if (declared && Number(declared) > MAX_DOWNLOAD_BYTES) {
    throw new Error(`response too large (${declared} bytes)`);
  }
  const body = await res.text();
  return { res, body };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const TOOLS: ToolSpec[] = [
  {
    name: 'web_get',
    description:
      'Fetch a web page or API resource and return readable content. HTML is converted to markdown ' +
      '(or plain text with format:"text", raw markup with format:"html"). Use this to read any URL, ' +
      'including JSON APIs (returned pretty-printed). Non-2xx statuses still return the response body.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch.' },
        format: { type: 'string', enum: ['markdown', 'text', 'html'], default: 'markdown', description: 'Output form for HTML documents.' },
        maxLength: { type: 'integer', default: DEFAULT_MAX_CHARS, maximum: MAX_CHARS_CAP, description: 'Maximum returned content characters.' },
      },
      required: ['url'],
    },
    async run(args) {
      const url = httpUrl(reqString(args, 'url'));
      const format = optEnum(args, 'format', ['markdown', 'text', 'html'] as const, 'markdown');
      const maxLength = optInt(args, 'maxLength', DEFAULT_MAX_CHARS, 200, MAX_CHARS_CAP);
      const { res, body } = await fetchText(url.toString(), DEFAULT_TIMEOUT_MS);
      const contentType = res.headers.get('content-type') ?? '';

      let content: string;
      let title: string | undefined;
      if (/html|xml/i.test(contentType)) {
        if (format === 'html') {
          content = body;
          title = undefined;
        } else {
          title = htmlToText(body, { markdown: false }).split('\n')[0]?.replace(/^# /, '');
          content = htmlToText(body, { markdown: format === 'markdown', baseUrl: res.url });
        }
      } else if (/json/i.test(contentType)) {
        try {
          content = JSON.stringify(JSON.parse(body), null, 2);
        } catch {
          content = body;
        }
      } else {
        content = body;
      }

      const limited = truncate(content, maxLength);
      return {
        status: res.status,
        finalUrl: res.url,
        contentType,
        ...(title !== undefined && title !== '' ? { title } : {}),
        truncated: limited.truncated,
        content: limited.text,
      };
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web via DuckDuckGo (HTML endpoint, no API key). Returns ranked title/url/snippet ' +
      'results. Pair with web_get to read a result page. Returns [] for no hits.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        maxResults: { type: 'integer', default: 8, minimum: 1, maximum: 25, description: 'Maximum results to return.' },
      },
      required: ['query'],
    },
    async run(args) {
      const query = reqString(args, 'query');
      const maxResults = optInt(args, 'maxResults', 8, 1, 25);

      let results: ReturnType<typeof parseDdgLite> = [];
      try {
        const { body } = await fetchText(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, DEFAULT_TIMEOUT_MS);
        results = parseDdgLite(body);
      } catch (err) {
        log(`web_search GET failed (${String(err)}); retrying via POST`);
      }
      if (results.length === 0) {
        const res = await fetch('https://lite.duckduckgo.com/lite/', {
          method: 'POST',
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
          headers: {
            'user-agent': USER_AGENT,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ q: query }).toString(),
        });
        results = parseDdgLite(await res.text());
      }

      return {
        engine: 'duckduckgo-lite',
        count: Math.min(results.length, maxResults),
        results: results.slice(0, maxResults).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet.slice(0, 300),
        })),
      };
    },
  },
  {
    name: 'web_links',
    description:
      'List unique absolute links on a page (navigation aid for crawling). Optionally filter by a ' +
      'case-insensitive regex matched against both the URL and the link text.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Page to extract links from.' },
        filter: { type: 'string', description: 'Optional regex source; matching URLs or link texts are kept.' },
        maxResults: { type: 'integer', default: 100, minimum: 1, maximum: 300, description: 'Maximum links to return.' },
      },
      required: ['url'],
    },
    async run(args) {
      const url = httpUrl(reqString(args, 'url'));
      const maxResults = optInt(args, 'maxResults', 100, 1, 300);
      const filterRe = args.filter === undefined
        ? null
        : new RegExp(String(args.filter), 'i');

      const { res, body } = await fetchText(url.toString(), DEFAULT_TIMEOUT_MS);
      let links = collectLinks(body, res.url, 500);
      const total = links.length;
      if (filterRe) links = links.filter((l) => filterRe.test(l.url) || filterRe.test(l.text));
      return {
        status: res.status,
        finalUrl: res.url,
        totalLinks: total,
        count: Math.min(links.length, maxResults),
        links: links.slice(0, maxResults),
      };
    },
  },
  {
    name: 'http_request',
    description:
      'Issue a generic HTTP request — POST forms/JSON, PATCH APIs, custom headers — and get status, ' +
      'content-type and the (truncated) body. For full browser-style page reading prefer web_get. ' +
      'Cookies are not persisted between calls.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], default: 'GET' },
        url: { type: 'string', description: 'Absolute http(s) URL.' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra request headers.' },
        json: { description: 'JSON-serializable request body; sets Content-Type application/json unless overridden.' },
        body: { type: 'string', description: 'Raw request body (used only when "json" is absent).' },
        timeoutMs: { type: 'integer', default: DEFAULT_TIMEOUT_MS, minimum: 1000, maximum: 120_000 },
        maxLength: { type: 'integer', default: DEFAULT_MAX_CHARS, maximum: MAX_CHARS_CAP },
      },
      required: ['url'],
    },
    async run(args) {
      const method = optEnum(args, 'method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const, 'GET');
      const url = httpUrl(reqString(args, 'url'));
      const timeoutMs = optInt(args, 'timeoutMs', DEFAULT_TIMEOUT_MS, 1_000, 120_000);
      const maxLength = optInt(args, 'maxLength', DEFAULT_MAX_CHARS, 200, MAX_CHARS_CAP);
      const headers: Record<string, string> = {
        'user-agent': USER_AGENT,
        ...Object.fromEntries(
          Object.entries((args.headers ?? {}) as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k.toLowerCase(), String(v)]),
        ),
      };

      let body: string | undefined;
      if (args.json !== undefined) {
        body = JSON.stringify(args.json);
        headers['content-type'] ??= 'application/json';
      } else if (typeof args.body === 'string') {
        body = args.body;
      }

      const res = await fetch(url.toString(), {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = res.body === null ? '' : await res.text();
      const limited = truncate(text, maxLength);
      return {
        status: res.status,
        ok: res.ok,
        finalUrl: res.url,
        contentType: res.headers.get('content-type'),
        location: res.headers.get('location'),
        truncated: limited.truncated,
        body: limited.text,
      };
    },
  },
  {
    name: 'web_download',
    description:
      'Download a file from a URL to an absolute local path (streamed, capped at 200 MB). Fails ' +
      'rather than overwriting unless overwrite:true. Returns bytes written.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL of the file.' },
        path: { type: 'string', description: 'Absolute destination filesystem path.' },
        overwrite: { type: 'boolean', default: false },
        timeoutMs: { type: 'integer', default: 120_000, minimum: 1000, maximum: 600_000 },
      },
      required: ['url', 'path'],
    },
    async run(args) {
      const url = httpUrl(reqString(args, 'url'));
      const destPath = reqString(args, 'path');
      if (!destPath.startsWith('/')) throw new ToolInputError('"path" must be absolute');
      const overwrite = args.overwrite === true;
      const timeoutMs = optInt(args, 'timeoutMs', 120_000, 1_000, 600_000);

      if (!overwrite && (await Bun.file(destPath).exists())) {
        throw new Error(`${destPath} already exists (pass overwrite:true to replace it)`);
      }

      const res = await fetch(url.toString(), {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': USER_AGENT },
      });
      if (!res.ok || res.body === null) {
        throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
      }

      const chunks: Uint8Array[] = [];
      let received = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_DOWNLOAD_BYTES) {
          await reader.cancel();
          throw new Error(`download exceeded ${MAX_DOWNLOAD_BYTES} byte cap`);
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      await Bun.write(destPath, merged);
      return {
        savedTo: destPath,
        bytes: received,
        contentType: res.headers.get('content-type'),
        source: res.url,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// MCP plumbing
// ---------------------------------------------------------------------------

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: JsonRpcRequest['id'], result: unknown): void {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function errorReply(id: JsonRpcRequest['id'], code: number, message: string): void {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

async function dispatch(params: Record<string, unknown>): Promise<unknown> {
  const name = params.name;
  if (typeof name !== 'string' || !TOOL_BY_NAME.has(name)) {
    throw new ToolInputError(`unknown tool: ${String(name)} (available: ${[...TOOL_BY_NAME.keys()].join(', ')})`);
  }
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  return TOOL_BY_NAME.get(name)!.run(args);
}

async function handleMessage(msg: JsonRpcRequest): Promise<void> {
  const hasId = msg.id !== undefined && msg.id !== null;
  switch (msg.method) {
    case 'initialize':
      if (!hasId) return;
      result(msg.id, {
        protocolVersion: typeof msg.params?.protocolVersion === 'string'
          && SUPPORTED_PROTOCOL_VERSIONS.has(msg.params.protocolVersion)
          ? msg.params.protocolVersion
          : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'webtools', version: '1.0.0' },
      });
      return;
    case 'ping':
      if (hasId) result(msg.id, {});
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'tools/list':
      if (!hasId) return;
      result(msg.id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
      return;
    case 'tools/call': {
      if (!hasId) return;
      try {
        const value = await dispatch(msg.params ?? {});
        // Text-only content keeps every consumer compatible; the payload is
        // structured JSON so the model can read fields directly.
        result(msg.id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          isError: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`tools/call failed: ${message}`);
        result(msg.id, { content: [{ type: 'text', text: message }], isError: true });
      }
      return;
    }
    default:
      if (hasId) errorReply(msg.id, -32601, `method not found: ${String(msg.method)}`);
      return;
  }
}

let chain: Promise<void> = Promise.resolve();
function enqueue(line: string): void {
  chain = chain.then(async () => {
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      errorReply(null, -32700, 'parse error');
      return;
    }
    if (Array.isArray(msg)) {
      errorReply(null, -32600, 'batch requests are not supported');
      return;
    }
    try {
      await handleMessage(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (msg.id !== undefined && msg.id !== null) errorReply(msg.id, -32603, message);
      log(`handler error on ${String(msg.method)}: ${message}`);
    }
  }).catch(() => { /* unreachable: handled inside */ });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) enqueue(line);
  }
});
process.stdin.on('end', () => process.exit(0));
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => process.exit(0));
}

log(`ready: ${TOOLS.length} tools (${TOOLS.map((t) => t.name).join(', ')})`);
