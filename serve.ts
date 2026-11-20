// A tiny static server for game/ (Node 22, standard library only), so the entry can be played
// locally without a build step: `node serve.ts` serves game/ on http://localhost:8080, and
// `node serve.ts --port N` picks another port. It sends the MIME types a browser game needs,
// refuses any path outside game/, and otherwise does nothing clever: this is a development
// convenience, not a web server for the internet.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 8080;
const root = resolve(fileURLToPath(new URL('./game', import.meta.url)));

// Parse `--port N`; anything missing or out of range falls back to the default.
function parsePort(argv: string[]): number {
  const flagIndex = argv.indexOf('--port');
  if (flagIndex === -1) return DEFAULT_PORT;
  const requested = Number(argv[flagIndex + 1]);
  const valid = Number.isInteger(requested) && requested > 0 && requested < 65536;
  return valid ? requested : DEFAULT_PORT;
}

const port = parsePort(process.argv.slice(2));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end('bad request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Resolve inside game/ and refuse anything that escapes it.
  const file = resolve(join(root, normalize(pathname)));
  if (file !== root && !file.startsWith(root + sep)) {
    response.writeHead(403).end('forbidden');
    return;
  }

  let size: number;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) throw new Error('not a file');
    size = stats.size;
  } catch {
    response.writeHead(404).end('not found');
    return;
  }

  response.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1', () => {
  console.log(`game/ is on http://localhost:${port}`);
}).on('error', (err) => {
  // A busy port is the common case; report it plainly and fail the process.
  if (err.code === 'EADDRINUSE') {
    console.error(`Error: port ${port} is already in use`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});
