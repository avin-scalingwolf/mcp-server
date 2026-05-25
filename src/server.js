import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import db from './db.js';
import { register as registerInspect } from './tools/inspect.js';
import { register as registerQuery } from './tools/query.js';

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

const mcp = new McpServer({
  name: 'scalingwolf-mcp',
  version: '2.0.0',
});

registerInspect(mcp, db);
registerQuery(mcp, db);

// One transport per SSE session. Without this, a second client kicks the first off.
const transports = new Map();

app.get('/sse', auth, async (req, res) => {
  const transport = new SSEServerTransport('/message', res);
  transports.set(transport.sessionId, transport);
  if (LOG_QUERIES) console.log(`[sse] connected sessionId=${transport.sessionId}`);
  res.on('close', () => {
    transports.delete(transport.sessionId);
    if (LOG_QUERIES) console.log(`[sse] disconnected sessionId=${transport.sessionId}`);
  });
  await mcp.server.connect(transport);
});

// No auth middleware on /message: some IDE clients can't add headers to the
// SSE POST channel, and the sessionId (an unguessable UUID established on the
// authenticated /sse GET) is itself the session capability token.
app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  if (!transport) {
    return res.status(400).send(`No active SSE transport for sessionId=${sessionId}`);
  }
  await transport.handlePostMessage(req, res);
});

app.listen(PORT, () => {
  console.log(`MCP Server v2.0.0 listening on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});
