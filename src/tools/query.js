import { z } from 'zod';

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function register(mcp, db) {
  mcp.tool(
    'query',
    'Execute an arbitrary SQL statement against the database. No restrictions — this is an internal magic-wand tool.',
    {
      sql: z.string().describe('The SQL statement to execute.'),
      params: z.array(z.any()).optional().describe('Optional positional parameters for $1, $2, ...'),
    },
    async ({ sql, params }) => {
      try {
        const r = await db.query(sql, params || []);
        return ok({
          command: r.command,
          rowCount: r.rowCount,
          rows: r.rows,
          fields: r.fields?.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
        });
      } catch (e) {
        return err(`query failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'sample_rows',
    'Fetch up to N rows from a table. Safer alternative to writing SELECT *. Limit is hard-capped at 1000.',
    {
      schema: z.string(),
      table: z.string(),
      limit: z.number().int().min(1).max(1000).optional().default(20),
      where: z.string().optional().describe('Raw WHERE clause without the WHERE keyword (e.g. "status = \'active\'").'),
      order_by: z.string().optional().describe('Raw ORDER BY clause without the ORDER BY keyword.'),
    },
    async ({ schema, table, limit, where, order_by }) => {
      try {
        const whereClause = where ? `WHERE ${where}` : '';
        const orderClause = order_by ? `ORDER BY ${order_by}` : '';
        const sql = `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} ${whereClause} ${orderClause} LIMIT ${Math.min(limit, 1000)};`;
        const r = await db.query(sql);
        return ok({ rows: r.rows, rowCount: r.rowCount });
      } catch (e) {
        return err(`sample_rows failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'row_count',
    'Return SELECT count(*) FROM table [WHERE …].',
    {
      schema: z.string(),
      table: z.string(),
      where: z.string().optional(),
    },
    async ({ schema, table, where }) => {
      try {
        const whereClause = where ? `WHERE ${where}` : '';
        const sql = `SELECT count(*)::bigint AS count FROM ${quoteIdent(schema)}.${quoteIdent(table)} ${whereClause};`;
        const r = await db.query(sql);
        return ok({ count: r.rows[0]?.count ?? 0 });
      } catch (e) {
        return err(`row_count failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'explain',
    'Run EXPLAIN [ANALYZE] on a query.',
    {
      sql: z.string(),
      analyze: z.boolean().optional().default(false),
      verbose: z.boolean().optional().default(false),
      format: z.enum(['text', 'json']).optional().default('text'),
    },
    async ({ sql, analyze, verbose, format }) => {
      try {
        const opts = [];
        if (analyze) opts.push('ANALYZE');
        if (verbose) opts.push('VERBOSE');
        opts.push(`FORMAT ${format.toUpperCase()}`);
        const r = await db.query(`EXPLAIN (${opts.join(', ')}) ${sql}`);
        if (format === 'json') {
          return ok(r.rows[0]?.['QUERY PLAN'] ?? r.rows);
        }
        const plan = r.rows.map((row) => row['QUERY PLAN']).join('\n');
        return { content: [{ type: 'text', text: plan }] };
      } catch (e) {
        return err(`explain failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'find_text',
    'Find rows where a text column matches a pattern (ILIKE). Limit is hard-capped at 500.',
    {
      schema: z.string(),
      table: z.string(),
      column: z.string(),
      pattern: z.string().describe('ILIKE pattern, e.g. "%foo%".'),
      limit: z.number().int().min(1).max(500).optional().default(50),
    },
    async ({ schema, table, column, pattern, limit }) => {
      try {
        const sql = `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} WHERE ${quoteIdent(column)}::text ILIKE $1 LIMIT ${Math.min(limit, 500)};`;
        const r = await db.query(sql, [pattern]);
        return ok({ rows: r.rows, rowCount: r.rowCount });
      } catch (e) {
        return err(`find_text failed: ${e.message}`);
      }
    },
  );
}
