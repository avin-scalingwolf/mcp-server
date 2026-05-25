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

function buildSetClause(values, startIndex = 1) {
  const cols = Object.keys(values);
  const assignments = cols.map((col, i) => `${quoteIdent(col)} = $${startIndex + i}`);
  return { clause: assignments.join(', '), params: cols.map((c) => values[c]) };
}

function buildInsertClause(values, startIndex = 1) {
  const cols = Object.keys(values);
  const placeholders = cols.map((_, i) => `$${startIndex + i}`);
  return {
    columns: cols.map(quoteIdent).join(', '),
    placeholders: placeholders.join(', '),
    params: cols.map((c) => values[c]),
  };
}

export function register(mcp, db, pool) {
  mcp.tool(
    'execute',
    'Execute arbitrary SQL (INSERT/UPDATE/DELETE/DDL/etc.). Returns command, rowCount, and any RETURNING rows.',
    {
      sql: z.string(),
      params: z.array(z.any()).optional(),
    },
    async ({ sql, params }) => {
      try {
        const r = await db.query(sql, params || []);
        return ok({
          command: r.command,
          rowCount: r.rowCount,
          rows: r.rows,
        });
      } catch (e) {
        return err(`execute failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'execute_tx',
    'Run an array of SQL statements in a single transaction. All-or-nothing: rolls back on the first error.',
    {
      statements: z.array(
        z.object({
          sql: z.string(),
          params: z.array(z.any()).optional(),
        }),
      ).min(1),
    },
    async ({ statements }) => {
      const client = await pool.connect();
      const results = [];
      try {
        await client.query('BEGIN');
        for (const stmt of statements) {
          const r = await client.query(stmt.sql, stmt.params || []);
          results.push({
            command: r.command,
            rowCount: r.rowCount,
            rows: r.rows,
          });
        }
        await client.query('COMMIT');
        return ok({ committed: true, statementCount: statements.length, results });
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        return err(`execute_tx rolled back at statement ${results.length + 1}: ${e.message}`);
      } finally {
        client.release();
      }
    },
  );

  mcp.tool(
    'insert_row',
    'Insert a row into a table. Returns the inserted row when returning is set (default "*").',
    {
      schema: z.string(),
      table: z.string(),
      values: z.record(z.string(), z.any()).describe('Column => value map.'),
      returning: z.string().optional().default('*').describe('RETURNING clause body. Set to empty string to omit.'),
    },
    async ({ schema, table, values, returning }) => {
      try {
        if (Object.keys(values).length === 0) return err('insert_row: values must not be empty.');
        const { columns, placeholders, params } = buildInsertClause(values);
        const ret = returning ? `RETURNING ${returning}` : '';
        const sql = `INSERT INTO ${quoteIdent(schema)}.${quoteIdent(table)} (${columns}) VALUES (${placeholders}) ${ret};`;
        const r = await db.query(sql, params);
        return ok({ rowCount: r.rowCount, rows: r.rows });
      } catch (e) {
        return err(`insert_row failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'update_rows',
    'Update rows in a table. WHERE clause is required to prevent table-wide updates by accident.',
    {
      schema: z.string(),
      table: z.string(),
      set: z.record(z.string(), z.any()).describe('Column => new-value map.'),
      where: z.string().describe('Raw WHERE clause without the WHERE keyword. Required.'),
      where_params: z.array(z.any()).optional().describe('Positional params for placeholders in the where clause (use $N where N continues after the set columns).'),
      returning: z.string().optional().default('*'),
    },
    async ({ schema, table, set, where, where_params, returning }) => {
      try {
        if (Object.keys(set).length === 0) return err('update_rows: set must not be empty.');
        if (!where || !where.trim()) return err('update_rows: where is required.');
        const { clause, params } = buildSetClause(set, 1);
        const allParams = [...params, ...(where_params || [])];
        const ret = returning ? `RETURNING ${returning}` : '';
        const sql = `UPDATE ${quoteIdent(schema)}.${quoteIdent(table)} SET ${clause} WHERE ${where} ${ret};`;
        const r = await db.query(sql, allParams);
        return ok({ rowCount: r.rowCount, rows: r.rows });
      } catch (e) {
        return err(`update_rows failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'delete_rows',
    'Delete rows from a table. WHERE clause is required to prevent table-wide deletes by accident.',
    {
      schema: z.string(),
      table: z.string(),
      where: z.string().describe('Raw WHERE clause without the WHERE keyword. Required.'),
      where_params: z.array(z.any()).optional(),
      returning: z.string().optional().default('*'),
    },
    async ({ schema, table, where, where_params, returning }) => {
      try {
        if (!where || !where.trim()) return err('delete_rows: where is required.');
        const ret = returning ? `RETURNING ${returning}` : '';
        const sql = `DELETE FROM ${quoteIdent(schema)}.${quoteIdent(table)} WHERE ${where} ${ret};`;
        const r = await db.query(sql, where_params || []);
        return ok({ rowCount: r.rowCount, rows: r.rows });
      } catch (e) {
        return err(`delete_rows failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'upsert_row',
    'INSERT … ON CONFLICT (cols) DO UPDATE. Pass on_conflict as a comma-separated column list or a constraint name (use on_conflict_constraint).',
    {
      schema: z.string(),
      table: z.string(),
      values: z.record(z.string(), z.any()),
      on_conflict: z.string().optional().describe('Comma-separated conflict columns (e.g. "workspace_id,key").'),
      on_conflict_constraint: z.string().optional().describe('Constraint name. Mutually exclusive with on_conflict.'),
      update_columns: z.array(z.string()).optional().describe('Columns to update on conflict. Defaults to all columns in values (EXCLUDED.col).'),
      returning: z.string().optional().default('*'),
    },
    async ({ schema, table, values, on_conflict, on_conflict_constraint, update_columns, returning }) => {
      try {
        if (Object.keys(values).length === 0) return err('upsert_row: values must not be empty.');
        if (!on_conflict && !on_conflict_constraint) return err('upsert_row: provide on_conflict or on_conflict_constraint.');
        const { columns, placeholders, params } = buildInsertClause(values);

        let conflictTarget;
        if (on_conflict_constraint) {
          conflictTarget = `ON CONSTRAINT ${quoteIdent(on_conflict_constraint)}`;
        } else {
          const cols = on_conflict.split(',').map((c) => quoteIdent(c.trim())).join(', ');
          conflictTarget = `(${cols})`;
        }

        const updateCols = (update_columns || Object.keys(values)).map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`).join(', ');
        const ret = returning ? `RETURNING ${returning}` : '';

        const sql = `
          INSERT INTO ${quoteIdent(schema)}.${quoteIdent(table)} (${columns})
          VALUES (${placeholders})
          ON CONFLICT ${conflictTarget} DO UPDATE SET ${updateCols}
          ${ret};
        `;
        const r = await db.query(sql, params);
        return ok({ rowCount: r.rowCount, rows: r.rows });
      } catch (e) {
        return err(`upsert_row failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'truncate',
    'TRUNCATE a table. Set cascade=true to TRUNCATE … CASCADE.',
    {
      schema: z.string(),
      table: z.string(),
      cascade: z.boolean().optional().default(false),
      restart_identity: z.boolean().optional().default(false),
    },
    async ({ schema, table, cascade, restart_identity }) => {
      try {
        const sql = `TRUNCATE TABLE ${quoteIdent(schema)}.${quoteIdent(table)} ${restart_identity ? 'RESTART IDENTITY' : ''} ${cascade ? 'CASCADE' : ''};`;
        const r = await db.query(sql);
        return ok({ truncated: `${schema}.${table}`, cascade, restart_identity, command: r.command });
      } catch (e) {
        return err(`truncate failed: ${e.message}`);
      }
    },
  );
}
