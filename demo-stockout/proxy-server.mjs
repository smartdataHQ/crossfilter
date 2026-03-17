/**
 * Dev server for the stockout dashboard.
 * Proxies /api/cube → Cube.dev /api/v1/load
 * Proxies /api/meta → Cube.dev /api/v1/meta
 *
 * Usage: node demo-stockout/proxy-server.mjs [port]
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2] || '3334', 10);
const envPath = path.resolve(ROOT, '.env');

const CUBE_HOST = 'dbx.fraios.dev';
const CUBE_LOAD_PATH = '/api/v1/load';
const CUBE_META_PATH = '/api/v1/meta';

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
  var config = {};
  if (!fs.existsSync(envPath)) return config;
  for (var line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    var eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    config[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
  }
  return config;
}

function withBearerPrefix(token) {
  if (!token) return '';
  return token.startsWith('Bearer ') ? token : 'Bearer ' + token;
}

function getAuthConfig(req) {
  var env = readEnvConfig();
  return {
    token: req.headers.authorization || withBearerPrefix(env.CUBE_TOKEN || process.env.CUBE_TOKEN || ''),
    datasourceId: req.headers['x-hasura-datasource-id'] || env.STOCKOUT_DATASOURCE || process.env.STOCKOUT_DATASOURCE || env.CUBE_DATASOURCE || process.env.CUBE_DATASOURCE || '',
    branchId: req.headers['x-hasura-branch-id'] || env.STOCKOUT_BRANCH || process.env.STOCKOUT_BRANCH || env.CUBE_BRANCH || process.env.CUBE_BRANCH || '',
  };
}

function proxyToCube(req, res, method, cubePath, body) {
  var auth = getAuthConfig(req);
  if (!auth.token || !auth.datasourceId || !auth.branchId) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing Cube config. Set CUBE_TOKEN, CUBE_DATASOURCE, CUBE_BRANCH in .env.' }));
    return;
  }

  var headers = {
    'Authorization': auth.token,
    'x-hasura-datasource-id': auth.datasourceId,
    'x-hasura-branch-id': auth.branchId,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  var proxyReq = https.request({
    hostname: CUBE_HOST,
    port: 443,
    path: cubePath,
    method: method,
    headers: headers,
  }, function (proxyRes) {
    var respHeaders = { 'Access-Control-Allow-Origin': '*' };
    for (var h of PROXY_RESPONSE_HEADERS) {
      if (proxyRes.headers[h] != null) respHeaders[h] = proxyRes.headers[h];
    }
    res.writeHead(proxyRes.statusCode, respHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.setTimeout(300000, function () {
    proxyReq.destroy(new Error('Proxy timeout'));
  });
  proxyReq.on('error', function (err) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Proxy error: ' + err.message);
    }
  });
  if (body) proxyReq.write(body);
  proxyReq.end();
}

function serveStatic(req, res) {
  var filePath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (filePath.endsWith('/')) filePath += 'index.html';
  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(filePath).pipe(res);
  });
}

var server = http.createServer(function (req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-hasura-branch-id, x-hasura-datasource-id',
    });
    res.end();
    return;
  }

  if (req.url === '/api/meta' && req.method === 'GET') {
    proxyToCube(req, res, 'GET', CUBE_META_PATH, null);
    return;
  }

  if (req.url === '/api/cube' && req.method === 'POST') {
    var body = '';
    req.on('data', function (chunk) { body += chunk; });
    req.on('end', function () { proxyToCube(req, res, 'POST', CUBE_LOAD_PATH, body); });
    return;
  }

  serveStatic(req, res);
});

server.timeout = 300000;
server.keepAliveTimeout = 300000;
server.listen(PORT, function () {
  console.log('Stockout dashboard dev server at http://localhost:' + PORT + '/');
  console.log('  Static: ' + ROOT);
  console.log('  Proxy: POST /api/cube -> https://' + CUBE_HOST + CUBE_LOAD_PATH);
  console.log('  Proxy: GET  /api/meta -> https://' + CUBE_HOST + CUBE_META_PATH);
});
