require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const db = require('./db');
const { isSafeQuery } = require('./security');

function auth(req, res, next) {
  const key = req.headers["x-api-key"];

  if (!key || key !== process.env.MCP_API_KEY) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

const app = express();
app.use(auth);
const PORT = process.env.PORT || 3000;

app.use(express.json());
// Log all queries (HTTP requests)
app.use(morgan('combined'));

// GET /health -> returns status ok
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// GET /tables -> lists all tables from information_schema
app.get('/tables', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT table_schema, table_name 
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
    `);
    res.json({ tables: result.rows });
  } catch (err) {
    console.error('Error fetching tables', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /query -> executes safe SELECT queries only
app.post('/query', async (req, res) => {
  const { query, params = [] } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  console.log('Received query:', query);

  if (!isSafeQuery(query)) {
    return res.status(403).json({ error: 'Query not allowed. Only SELECT queries are permitted.' });
  }

  try {
    const result = await db.query(query, params);
    res.json({ rows: result.rows, rowCount: result.rowCount });
  } catch (err) {
    console.error('Error executing query', err);
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`MCP Gateway server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
