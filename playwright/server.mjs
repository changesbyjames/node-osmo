import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.map')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.ts')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function safeJoin(root, requestedPath) {
  const clean = requestedPath.replace(/\0/g, '');
  const joined = path.resolve(root, '.' + clean);
  if (!joined.startsWith(root)) return null;
  return joined;
}

const args = process.argv.slice(2);
const portArgIndex = args.indexOf('--port');
const port = portArgIndex >= 0 ? Number(args[portArgIndex + 1]) : 4173;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    let pathname = url.pathname;
    if (pathname === '/') pathname = '/playwright/static/blank.html';

    const abs = safeJoin(repoRoot, pathname);
    if (!abs) {
      res.writeHead(400);
      res.end('Bad path');
      return;
    }

    const data = await readFile(abs);
    res.writeHead(200, {
      'content-type': contentType(abs),
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`playwright static server listening on http://127.0.0.1:${port}`);
});

