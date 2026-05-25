import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import crypto, { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import db, { pool } from './db.js';
import { register as registerInspect } from './tools/inspect.js';
import { register as registerQuery } from './tools/query.js';
import { register as registerMutate } from './tools/mutate.js';
import { register as registerMigrate } from './tools/migrate.js';

const app = express();
const PORT = process.env.PORT || 3000;
const LOG_QUERIES = process.env.LOG_QUERIES === 'true';

app.use(morgan('combined'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Accept the API key from either the `x-api-key` header or the `?key=` query
// parameter — some IDE clients can't attach custom headers to the SSE GET.
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  const expected = process.env.MCP_API_KEY;
  if (!expected || !key || !timingSafeEqualStr(key, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function createMcpServer() {
  const mcp = new McpServer({
    name: 'scalingwolf-mcp',
    version: '2.1.0',
  });

  registerInspect(mcp, db);
  registerQuery(mcp, db);
  registerMutate(mcp, db, pool);
  registerMigrate(mcp, db);

  return mcp;
}

// --- SSE transport (legacy, for older clients) ---
// One transport per SSE session; without this map a second client kicks the first off.
const sseTransports = new Map();

// The MCP SDK's SSEServerTransport always emits a relative URL in the
// `endpoint` event (it strips host/scheme — see node_modules/.../sse.js). Some
// MCP clients (Antigravity, older Inspector, certain SDK ports) feed that
// string into `new URL(data)` without a base and crash, surfacing as
// "session not found (session ID: )". To stay compatible without forking the
// SDK, we rewrite the first endpoint event on the wire to use an absolute URL.
function absoluteBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function rewriteEndpointEventToAbsolute(res, baseUrl) {
  const originalWrite = res.write.bind(res);
  let rewritten = false;
  res.write = function patchedWrite(chunk, ...rest) {
    if (!rewritten && typeof chunk === 'string' && chunk.startsWith('event: endpoint\ndata: /')) {
      rewritten = true;
      chunk = chunk.replace(
        /^event: endpoint\ndata: (\/[^\n]*)/,
        (_, path) => `event: endpoint\ndata: ${baseUrl}${path}`,
      );
    }
    return originalWrite(chunk, ...rest);
  };
}

app.get('/sse', auth, async (req, res) => {
  rewriteEndpointEventToAbsolute(res, absoluteBaseUrl(req));
  const transport = new SSEServerTransport('/message', res);
  sseTransports.set(transport.sessionId, transport);
  if (LOG_QUERIES) console.log(`[sse] connected sessionId=${transport.sessionId}`);
  res.on('close', () => {
    sseTransports.delete(transport.sessionId);
    if (LOG_QUERIES) console.log(`[sse] disconnected sessionId=${transport.sessionId}`);
  });
  try {
    const mcp = createMcpServer();
    await mcp.server.connect(transport);
  } catch (err) {
    console.error('[sse] connect error:', err);
  }
});

// No auth middleware on /message: some IDE clients can't add headers to the
// SSE POST channel, and the sessionId (an unguessable UUID established on the
// authenticated /sse GET) is itself the session capability token.
app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    return res.status(400).send(`No active SSE transport for sessionId=${sessionId}`);
  }
  await transport.handlePostMessage(req, res);
});

// --- Streamable HTTP transport (modern; preferred by Antigravity, current Claude Code, etc.) ---
// JSON body parser is scoped to /mcp so it doesn't interfere with the SSE /message stream.
const httpTransports = new Map();

// The MCP SDK's StreamableHTTPServerTransport requires the client to send
// `Accept: application/json, text/event-stream` exactly — otherwise it
// returns 406 Not Acceptable. Several real clients (Antigravity, ad-hoc
// agents, browser fetch) send `Accept: */*` or omit Accept entirely. Since
// this is an internal tool we'd rather succeed than be strict, so we
// synthesize the dual-Accept header when the client's Accept doesn't already
// satisfy the SDK.
//
// The Node wrapper inside the SDK pulls headers from `req.rawHeaders`, not
// `req.headers`, so we must mutate the raw array to take effect.
const RELAXED_ACCEPT = 'application/json, text/event-stream';
function relaxAcceptHeader(req, _res, next) {
  const current = String(req.headers.accept || '').toLowerCase();
  const ok = current.includes('application/json') && current.includes('text/event-stream');
  if (ok) return next();

  req.headers.accept = RELAXED_ACCEPT;
  const raw = req.rawHeaders || [];
  let found = false;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === 'accept') {
      raw[i + 1] = RELAXED_ACCEPT;
      found = true;
      break;
    }
  }
  if (!found) raw.push('Accept', RELAXED_ACCEPT);
  next();
}

app.all('/mcp', auth, relaxAcceptHeader, express.json(), async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (sessionId && httpTransports.has(sessionId)) {
      transport = httpTransports.get(sessionId);
    } else if (req.method === 'POST' && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          httpTransports.set(id, transport);
          if (LOG_QUERIES) console.log(`[http] connected sessionId=${id}`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          httpTransports.delete(transport.sessionId);
          if (LOG_QUERIES) console.log(`[http] disconnected sessionId=${transport.sessionId}`);
        }
      };
      const mcp = createMcpServer();
      await mcp.server.connect(transport);
    } else {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid session ID and not an initialize request' },
        id: null,
      });
    }

    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[http] error:', e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: `Internal error: ${e.message}` },
        id: null,
      });
    }
  }
});

app.listen(PORT, async () => {
  console.log(`MCP Server v2.1.0 listening on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`SSE endpoint (legacy):      GET  /sse  + POST /message`);
  console.log(`Streamable HTTP endpoint:   ALL  /mcp`);

  try {
    const res = await db.query("SELECT count(*) FROM core.users", []);
    
    // Calculate total active schemas (excluding supabase internals)
    const HIDDEN_SCHEMAS = [
      'information_schema', 'pg_catalog', 'pg_toast', 'auth', 'realtime', 'storage', 'vault',
      'extensions', 'graphql', 'graphql_public', 'supabase_functions', 'supabase_migrations',
      'net', 'pgsodium', 'pgsodium_masks', 'cron'
    ];
    const schemaRes = await db.query(`
      SELECT count(*) FROM pg_namespace n
      WHERE n.nspname NOT LIKE 'pg_%'
        AND n.nspname <> 'information_schema'
        AND n.nspname NOT IN (${HIDDEN_SCHEMAS.map(s => `'${s}'`).join(',')})
    `);

    console.log("===== STARTUP DIAGNOSTICS =====");
    console.log(`Total users in core.users: ${res.rows[0].count}`);
    console.log(`Total active schemas: ${schemaRes.rows[0].count}`);
    console.log("===============================");
  } catch (e) {
    console.error("Error querying users on startup:", e.message);
  }
});
