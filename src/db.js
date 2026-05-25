import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  statement_timeout: Number(process.env.STATEMENT_TIMEOUT_MS || 30000),
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle pg client:', err.message);
});

export default {
  query: (text, params) => pool.query(text, params),
};
