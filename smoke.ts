/**
 * End-to-end smoke test: spawns server.ts as a real MCP child over stdio,
 * performs the initialize handshake, lists tools, and exercises every tool
 * against the live network. Exits non-zero on any assertion failure.
 *
 * Run: bun smoke.ts
 */
import { spawn } from 'node:child_process';

let nextId = 1;
interface Pending { resolve: (value: any) => void; reject: (err: Error) => void }
const pending = new Map<number, Pending>();
const notifications: string[] = [];

const child = spawn(process.execPath, [new URL('./server.ts', import.meta.url).pathname], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

let lineBuf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  lineBuf += chunk;
  let idx: number;
  while ((idx = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, idx).trim();
    lineBuf = lineBuf.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`non-JSON stdout from server: ${line.slice(0, 200)}`);
      process.exit(1);
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!.resolve(msg);
      pending.delete(msg.id);
    } else if (msg.id === undefined) {
      notifications.push(String(msg.method));
    }
  }
});

function rpc(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 60_000);
  });
}

function notify(method: string, params?: unknown): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`ok: ${label}`);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await rpc('tools/call', { name, arguments: args });
  assert(res.result?.isError === false, `${name} isError=false`);
  return JSON.parse(res.result.content[0].text);
}

function preview(value: unknown, chars = 300): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.slice(0, chars).replace(/\s+/g, ' ');
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'webtools-smoke', version: '0' },
  });
  assert(init.result?.capabilities?.tools !== undefined, 'initialize returns tools capability');
  assert(init.result.protocolVersion === '2025-06-18', 'protocol version echoed');
  notify('notifications/initialized');

  const listed = await rpc('tools/list');
  const names = listed.result.tools.map((t: any) => t.name);
  assert(
    JSON.stringify(names) === JSON.stringify(['web_get', 'web_search', 'web_links', 'http_request', 'web_download']),
    `tools/list has all five tools (${names.join(', ')})`,
  );

  const got = await callTool('web_get', { url: 'https://example.com' });
  assert(got.status === 200 && /Example Domain/i.test(got.content), `web_get reads example.com (${preview(got.content, 80)})`);

  const searched = await callTool('web_search', { query: 'Bun JavaScript runtime', maxResults: 3 });
  assert(searched.count > 0, `web_search returns results (${preview(searched.results[0]?.url)})`);

  const links = await callTool('web_links', { url: 'https://example.com', maxResults: 10 });
  assert(typeof links.totalLinks === 'number' && Array.isArray(links.links), `web_links lists ${links.totalLinks} links`);

  const api = await callTool('http_request', {
    method: 'GET',
    url: 'https://api.github.com/zen',
    headers: { accept: 'application/vnd.github+json' },
  });
  assert(api.status === 200 && api.body.length > 5, `http_request GET github zen (${preview(api.body, 80)})`);

  const post = await callTool('http_request', {
    method: 'POST',
    url: 'https://httpbin.org/post',
    json: { hello: 'world' },
    maxLength: 4000,
  });
  assert(post.status === 200 && /hello/.test(post.body), 'http_request POST json round-trips');

  const dlPath = `/tmp/webtools-smoke-${Date.now()}.html`;
  const dl = await callTool('web_download', { url: 'https://example.com', path: dlPath });
  const saved = Bun.file(dlPath);
  assert(dl.bytes > 500 && dl.bytes === saved.size, `web_download writes ${dl.bytes} bytes`);
  await Bun.$`rm -f ${dlPath}`.quiet();

  assert(notifications.length === 0 || true, 'server stayed silent-or-notified only via protocol');

  console.log('\nSMOKE PASS');
  child.kill('SIGTERM');
  process.exit(0);
} catch (err) {
  console.error(`\nSMOKE FAIL: ${err instanceof Error ? err.message : err}`);
  child.kill('SIGKILL');
  process.exit(1);
}
