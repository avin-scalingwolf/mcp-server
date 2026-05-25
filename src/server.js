import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import db from './db.js';
import { isSafeQuery } from './security.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Log all queries (HTTP requests)
app.use(morgan('combined'));

// Legacy health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Authentication middleware
function auth(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (!key || key !== process.env.MCP_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Initialize MCP Server
function createMcpServer() {
  const mcp = new McpServer({
    name: "supabase-mcp",
    version: "1.0.0"
  });

// Register Tool: list_tables
mcp.tool("list_tables",
  "List all available tables in the database",
  {},
  async () => {
    try {
      const result = await db.query(`
        SELECT table_schema, table_name 
        FROM information_schema.tables 
        WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
      `);
      return {
        content: [{ type: "text", text: JSON.stringify({ tables: result.rows }, null, 2) }]
      };
    } catch (err) {
      console.error('Error fetching tables', err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error fetching tables: ${err.message}` }]
      };
    }
  }
);

// Register Tool: query_database
mcp.tool("query_database",
  "Execute a safe SELECT query against the database",
  { 
    query: z.string().describe("The SQL query to execute")
  },
  async ({ query }) => {
    console.log('Received query via MCP:', query);
    
    if (!isSafeQuery(query)) {
      return {
        isError: true,
        content: [{ type: "text", text: 'Query not allowed. Only SELECT queries are permitted.' }]
      };
    }

    try {
      const result = await db.query(query, []);
      return {
        content: [{ type: "text", text: JSON.stringify({ rows: result.rows, rowCount: result.rowCount }, null, 2) }]
      };
    } catch (err) {
      console.error('Error executing query', err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error executing query: ${err.message}` }]
      };
    }
  }
);

  return mcp;
}

// MCP endpoints over SSE
const sessions = new Map();

app.get("/sse", auth, async (req, res) => {
  console.log("New SSE connection established");
  const transport = new SSEServerTransport("/message", res);
  const mcp = createMcpServer();
  sessions.set(transport.sessionId, { transport, mcp });
  await mcp.server.connect(transport);
  
  res.on('close', () => {
    sessions.delete(transport.sessionId);
  });
});

app.post("/message", auth, async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);
  if (session) {
    await session.transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No active SSE connection for this session");
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`MCP SSE endpoint: http://localhost:${PORT}/sse`);
});
