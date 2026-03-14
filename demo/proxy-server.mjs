/**
 * Lightweight dev server that serves static files AND proxies
 * /api/cube → https://dbx.fraios.dev/api/v1/load
 * to avoid CORS issues when fetching live Arrow data.
 *
 * Usage: node demo/proxy-server.mjs [port]
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2] || '3333', 10);
const envPath = path.resolve(ROOT, '.env');

const CUBE_API = 'https://dbx.fraios.dev/api/v1/load';

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.arrow':'application/vnd.apache.arrow.stream',
  '.wasm': 'application/wasm',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const PROXY_RESPONSE_HEADERS = [
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-length',
  'content-type',
  'transfer-encoding',
  'x-request-id',
  'x-synmetrix-arrow-field-mapping',
  'x-synmetrix-arrow-field-mapping-encoding',
];

function readEnvConfig() {
  const config = {};

  if (!fs.existsSync(envPath)) {
    return config;
  }

  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const val = trimmed.slice(eqIndex + 1).trim();
    config[key] = val;
  }

  return config;
}

function withBearerPrefix(token) {
  if (!token) {
    return '';
  }
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
}

function getProxyAuthConfig(req) {
  const envConfig = readEnvConfig();
  return {
    branchId: req.headers['x-hasura-branch-id'] || envConfig.CUBE_BRANCH || process.env.CUBE_BRANCH || '',
    datasourceId: req.headers['x-hasura-datasource-id'] || envConfig.CUBE_DATASOURCE || process.env.CUBE_DATASOURCE || '',
    token: req.headers.authorization || withBearerPrefix(envConfig.CUBE_TOKEN || process.env.CUBE_TOKEN || ''),
  };
}

function serveStatic(req, res) {
  let filePath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (filePath.endsWith('/')) filePath += 'index.html';

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function proxyCube(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const authConfig = getProxyAuthConfig(req);
    if (!authConfig.token || !authConfig.datasourceId || !authConfig.branchId) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Missing Cube live configuration. Set CUBE_TOKEN, CUBE_DATASOURCE, and CUBE_BRANCH in .env or send Authorization/x-hasura-* headers to /api/cube.',
      }));
      return;
    }

    const url = new URL(CUBE_API);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authConfig.token,
        'x-hasura-datasource-id': authConfig.datasourceId,
        'x-hasura-branch-id': authConfig.branchId,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const proxyReq = https.request(options, (proxyRes) => {
      const headers = {
        'Access-Control-Allow-Origin': '*',
      };

      for (const headerName of PROXY_RESPONSE_HEADERS) {
        const headerValue = proxyRes.headers[headerName];
        if (headerValue == null) continue;
        headers[headerName] = headerValue;
      }

      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });

    // Allow up to 5 minutes for heavy Cube.dev queries
    proxyReq.setTimeout(300000, () => {
      console.error('Proxy timeout after 5 minutes');
      proxyReq.destroy(new Error('Proxy timeout'));
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxy error: ' + err.message);
      }
    });

    proxyReq.write(body);
    proxyReq.end();
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-hasura-branch-id, x-hasura-datasource-id',
    });
    res.end();
    return;
  }

  if (req.url === '/api/cube' && req.method === 'POST') {
    proxyCube(req, res);
  } else {
    serveStatic(req, res);
  }
});

// Allow long-running Cube.dev queries (5 min timeout)
server.timeout = 300000;
server.keepAliveTimeout = 300000;

server.listen(PORT, () => {
  console.log(`Dev server with Cube.dev proxy running at http://localhost:${PORT}/`);
  console.log(`  Static files: ${ROOT}`);
  console.log(`  Proxy: POST /api/cube → ${CUBE_API}`);
});
