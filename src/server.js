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

// One McpServer instance; tools are registered once and shared by every transport.
const mcp = new McpServer({
  name: 'scalingwolf-mcp',
  version: '2.1.0',
});

registerInspect(mcp, db);
registerQuery(mcp, db);
registerMutate(mcp, db, pool);
registerMigrate(mcp, db);

// --- SSE transport (legacy, for older clients) ---
// One transport per SSE session; without this map a second client kicks the first off.
const sseTransports = new Map();

app.get('/sse', auth, async (req, res) => {
  const transport = new SSEServerTransport('/message', res);
  sseTransports.set(transport.sessionId, transport);
  if (LOG_QUERIES) console.log(`[sse] connected sessionId=${transport.sessionId}`);
  res.on('close', () => {
    sseTransports.delete(transport.sessionId);
    if (LOG_QUERIES) console.log(`[sse] disconnected sessionId=${transport.sessionId}`);
  });
  await mcp.server.connect(transport);
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

app.all('/mcp', auth, express.json(), async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`MCP Server v2.1.0 listening on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`SSE endpoint (legacy):      GET  /sse  + POST /message`);
  console.log(`Streamable HTTP endpoint:   ALL  /mcp`);
});
