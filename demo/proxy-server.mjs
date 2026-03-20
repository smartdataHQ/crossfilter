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
const CUBE_META_API = 'https://dbx.fraios.dev/api/v1/meta';

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
    const authConfig = getProxyAuthConfig(req);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'X-Crossfilter-Demo-Proxy': '1',
      'X-Crossfilter-Live-Configured': authConfig.token && authConfig.datasourceId && authConfig.branchId ? '1' : '0',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

function proxyMeta(req, res) {
  const authConfig = getProxyAuthConfig(req);
  if (!authConfig.token || !authConfig.datasourceId || !authConfig.branchId) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing Cube config for /api/meta. Set CUBE_TOKEN, CUBE_DATASOURCE, CUBE_BRANCH in .env.' }));
    return;
  }

  const url = new URL(CUBE_META_API);
  const options = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname,
    method: 'GET',
    headers: {
      'Authorization': authConfig.token,
      'x-hasura-datasource-id': authConfig.datasourceId,
      'x-hasura-branch-id': authConfig.branchId,
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    const headers = { 'Access-Control-Allow-Origin': '*' };
    for (const headerName of PROXY_RESPONSE_HEADERS) {
      const headerValue = proxyRes.headers[headerName];
      if (headerValue == null) continue;
      headers[headerName] = headerValue;
    }
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.setTimeout(30000, () => {
    proxyReq.destroy(new Error('Meta proxy timeout'));
  });
  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Meta proxy error: ' + err.message);
    }
  });
  proxyReq.end();
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

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json',
  });
  res.end(body);
}

// ── Dashboard builder: generate config via OpenAI ───────────────────

function handleDashboardGenerate(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const payload = JSON.parse(body);
      const { messages, cubeNames } = payload;

      if (!messages || !Array.isArray(messages)) {
        sendJson(res, 400, { error: 'messages[] required' });
        return;
      }

      const envConfig = readEnvConfig();
      const openaiKey = envConfig.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
      if (!openaiKey) {
        sendJson(res, 500, { error: 'OPENAI_API_KEY not configured' });
        return;
      }

      // Dynamic import of schema generator (ESM)
      const { generateDashboardSchema, generateSystemPrompt, schemaStats } =
        await import('./schema/generate-schema.js');

      // Fetch cube meta (or use cached)
      const metaCachePath = path.join(ROOT, '.cache', 'cube-meta.json');
      let metaResponse;
      try {
        if (fs.existsSync(metaCachePath)) {
          metaResponse = JSON.parse(fs.readFileSync(metaCachePath, 'utf8'));
        }
      } catch (_) {}

      if (!metaResponse) {
        // Fetch live
        const authConfig = getProxyAuthConfig(req);
        metaResponse = await new Promise((resolve, reject) => {
          const mReq = https.request({
            hostname: new URL(CUBE_META_API).hostname,
            port: 443,
            path: new URL(CUBE_META_API).pathname,
            method: 'GET',
            headers: {
              'Authorization': authConfig.token,
              'x-hasura-datasource-id': authConfig.datasourceId,
              'x-hasura-branch-id': authConfig.branchId,
            },
          }, mRes => {
            const chunks = [];
            mRes.on('data', c => chunks.push(c));
            mRes.on('end', () => {
              if (mRes.statusCode !== 200) { reject(new Error('Meta ' + mRes.statusCode)); return; }
              const parsed = JSON.parse(Buffer.concat(chunks).toString());
              // Cache for subsequent calls
              fs.mkdirSync(path.dirname(metaCachePath), { recursive: true });
              fs.writeFileSync(metaCachePath, JSON.stringify(parsed));
              resolve(parsed);
            });
          });
          mReq.on('error', reject);
          mReq.setTimeout(30000, () => mReq.destroy(new Error('Meta timeout')));
          mReq.end();
        });
      }

      const cubes = cubeNames || ['bluecar_stays'];
      const schema = generateDashboardSchema(metaResponse, cubes, { supportedOnly: true });
      const systemPrompt = generateSystemPrompt(metaResponse, cubes);

      // Build OpenAI messages: system + conversation
      const openaiMessages = [
        { role: 'system', content: systemPrompt },
        ...messages,
      ];

      // Call OpenAI
      const openaiBody = JSON.stringify({
        model: envConfig.OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o',
        messages: openaiMessages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'dashboard_config', strict: true, schema },
        },
      });

      const config = await new Promise((resolve, reject) => {
        const oReq = https.request({
          hostname: 'api.openai.com',
          port: 443,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + openaiKey,
            'Content-Length': Buffer.byteLength(openaiBody),
          },
        }, oRes => {
          const chunks = [];
          oRes.on('data', c => chunks.push(c));
          oRes.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            if (oRes.statusCode !== 200) {
              reject(new Error('OpenAI ' + oRes.statusCode + ': ' + raw.slice(0, 300)));
              return;
            }
            try {
              const parsed = JSON.parse(raw);
              const choice = parsed.choices && parsed.choices[0];
              if (!choice || !choice.message || !choice.message.content) {
                reject(new Error('No content in OpenAI response'));
                return;
              }
              if (choice.message.refusal) {
                reject(new Error('Model refused: ' + choice.message.refusal));
                return;
              }
              resolve({
                config: JSON.parse(choice.message.content),
                usage: parsed.usage || {},
                finishReason: choice.finish_reason,
              });
            } catch (e) {
              reject(new Error('Parse error: ' + e.message));
            }
          });
        });
        oReq.on('error', reject);
        oReq.setTimeout(120000, () => oReq.destroy(new Error('OpenAI timeout')));
        oReq.write(openaiBody);
        oReq.end();
      });

      // Save as _draft.json
      const draftPath = path.join(ROOT, 'demo', 'dashboards', '_draft.json');
      fs.writeFileSync(draftPath, JSON.stringify(config.config, null, 2));

      sendJson(res, 200, {
        config: config.config,
        usage: config.usage,
        finishReason: config.finishReason,
      });

    } catch (err) {
      console.error('[generate]', err.message);
      sendJson(res, 500, { error: err.message });
    }
  });
}

function serveDashboardShell(req, res) {
  const shellPath = path.join(ROOT, 'demo', 'dashboard.html');
  fs.stat(shellPath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Dashboard shell not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Length': stat.size,
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(shellPath).pipe(res);
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

  if (req.url === '/api/cube/info' && req.method === 'GET') {
    const authConfig = getProxyAuthConfig(req);
    sendJson(res, 200, {
      configured: !!(authConfig.token && authConfig.datasourceId && authConfig.branchId),
      cubeApi: CUBE_API,
      proxy: true,
    });
    return;
  }

  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (req.method === 'GET' && urlPath === '/api/chart-support') {
    import('./chart-support.js').then(function (mod) {
      var body = JSON.stringify({
        supported: mod.listSupported(),
        unsupported: mod.listUnsupported(),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    }).catch(function (err) {
      sendJson(res, 500, { error: err.message });
    });
    return;
  }

  if (req.url === '/api/dashboard/generate' && req.method === 'POST') {
    handleDashboardGenerate(req, res);
  } else if (req.url === '/api/meta' && req.method === 'GET') {
    proxyMeta(req, res);
  } else if (req.url === '/api/cube' && req.method === 'POST') {
    proxyCube(req, res);
  } else if (urlPath.startsWith('/demo/dashboards/') && !path.extname(urlPath)) {
    // Clean URL: /demo/dashboards/bluecar-stays → serve dashboard.html
    // The engine reads the dashboard name from location.pathname
    serveDashboardShell(req, res);
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
  console.log(`  Proxy: GET  /api/meta → ${CUBE_META_API}`);
});
