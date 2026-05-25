import { z } from 'zod';

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// Known migration tables we'll probe.
const MIGRATION_TABLES = [
  { schema: 'supabase_migrations', table: 'schema_migrations', versionCol: 'version', nameCol: 'name' },
  { schema: 'public', table: 'schema_migrations', versionCol: 'version', nameCol: null },
  { schema: 'public', table: 'gorp_migrations', versionCol: 'id', nameCol: null },
  { schema: 'sys', table: 'migrations', versionCol: 'version', nameCol: 'name' },
];

async function tableExists(db, schema, table) {
  const r = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 LIMIT 1;`,
    [schema, table],
  );
  return r.rowCount > 0;
}

export function register(mcp, db) {
  mcp.tool(
    'list_migrations',
    'List applied migrations from known migration tables (supabase_migrations.schema_migrations, public.gorp_migrations, sys.migrations, etc.). Pass a specific schema/table to override probing.',
    {
      schema: z.string().optional(),
      table: z.string().optional(),
      version_column: z.string().optional().default('version'),
      name_column: z.string().optional(),
      limit: z.number().int().min(1).max(2000).optional().default(500),
    },
    async ({ schema, table, version_column, name_column, limit }) => {
      try {
        const probed = [];
        const candidates = schema && table
          ? [{ schema, table, versionCol: version_column, nameCol: name_column ?? null }]
          : MIGRATION_TABLES;

        for (const cand of candidates) {
          const exists = await tableExists(db, cand.schema, cand.table);
          if (!exists) {
            probed.push({ ...cand, found: false });
            continue;
          }
          const cols = [`"${cand.versionCol}" AS version`];
          if (cand.nameCol) cols.push(`"${cand.nameCol}" AS name`);
          const sql = `SELECT ${cols.join(', ')} FROM "${cand.schema}"."${cand.table}" ORDER BY 1 DESC LIMIT ${limit};`;
          const r = await db.query(sql);
          probed.push({ ...cand, found: true, count: r.rowCount, rows: r.rows });
        }
        return ok({ probed });
      } catch (e) {
        return err(`list_migrations failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'apply_migration',
    'Apply a migration SQL block in a transaction, then record it in supabase_migrations.schema_migrations. Override schema/table for non-Supabase migration tracking.',
    {
      version: z.string().describe('Migration version (e.g. "20260525120000" or "0054_outbox_partition").'),
      name: z.string().optional().describe('Human-readable migration name.'),
      sql: z.string().describe('Migration SQL to execute.'),
      tracking_schema: z.string().optional().default('supabase_migrations'),
      tracking_table: z.string().optional().default('schema_migrations'),
      record: z.boolean().optional().default(true).describe('Set false to apply without recording (e.g. for ad-hoc patches).'),
    },
    async ({ version, name, sql, tracking_schema, tracking_table, record }) => {
      const pool = db._pool || db; // db is { query, _pool } — guard
      const client = await (db._pool ? db._pool.connect() : null);
      try {
        if (!client) {
          // Fall back to single-shot if pool is not exposed.
          if (record) {
            await db.query(
              `BEGIN; ${sql}; INSERT INTO "${tracking_schema}"."${tracking_table}" (version, name, statements) VALUES ($1, $2, ARRAY[$3]) ON CONFLICT (version) DO NOTHING; COMMIT;`,
              [version, name || null, sql],
            );
          } else {
            await db.query(sql);
          }
          return ok({ applied: true, version, recorded: record });
        }

        await client.query('BEGIN');
        await client.query(sql);
        if (record) {
          // supabase_migrations.schema_migrations columns: version, statements (text[]), name
          const cols = await client.query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = $2;`,
            [tracking_schema, tracking_table],
          );
          const colNames = cols.rows.map((c) => c.column_name);
          const insertCols = ['version'];
          const insertVals = [version];
          if (colNames.includes('name')) { insertCols.push('name'); insertVals.push(name || null); }
          if (colNames.includes('statements')) { insertCols.push('statements'); insertVals.push([sql]); }
          const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(', ');
          await client.query(
            `INSERT INTO "${tracking_schema}"."${tracking_table}" (${insertCols.map((c) => `"${c}"`).join(', ')})
             VALUES (${placeholders})
             ON CONFLICT (version) DO NOTHING;`,
            insertVals,
          );
        }
        await client.query('COMMIT');
        return ok({ applied: true, version, recorded: record });
      } catch (e) {
        if (client) {
          try { await client.query('ROLLBACK'); } catch {}
        }
        return err(`apply_migration rolled back: ${e.message}`);
      } finally {
        if (client) client.release();
      }
    },
  );

  mcp.tool(
    'pending_migrations',
    'Given a list of expected migration versions/names, return which are not yet applied. Lets the agent diff a local migrations directory against this database.',
    {
      expected: z.array(
        z.object({
          version: z.string(),
          name: z.string().optional(),
        }),
      ),
      tracking_schema: z.string().optional().default('supabase_migrations'),
      tracking_table: z.string().optional().default('schema_migrations'),
      version_column: z.string().optional().default('version'),
    },
    async ({ expected, tracking_schema, tracking_table, version_column }) => {
      try {
        const exists = await tableExists(db, tracking_schema, tracking_table);
        if (!exists) {
          return err(`Tracking table ${tracking_schema}.${tracking_table} not found.`);
        }
        const r = await db.query(
          `SELECT "${version_column}" AS version FROM "${tracking_schema}"."${tracking_table}";`,
        );
        const applied = new Set(r.rows.map((row) => String(row.version)));
        const pending = expected.filter((e) => !applied.has(String(e.version)));
        return ok({
          applied_count: applied.size,
          expected_count: expected.length,
          pending_count: pending.length,
          pending,
        });
      } catch (e) {
        return err(`pending_migrations failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'migration_diff',
    'List versions present in this DB. The agent should call this on testing AND prod and diff the results to find env drift.',
    {
      tracking_schema: z.string().optional().default('supabase_migrations'),
      tracking_table: z.string().optional().default('schema_migrations'),
      version_column: z.string().optional().default('version'),
      name_column: z.string().optional().default('name'),
    },
    async ({ tracking_schema, tracking_table, version_column, name_column }) => {
      try {
        const exists = await tableExists(db, tracking_schema, tracking_table);
        if (!exists) return err(`Tracking table ${tracking_schema}.${tracking_table} not found.`);
        const cols = await db.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2;`,
          [tracking_schema, tracking_table],
        );
        const colNames = cols.rows.map((c) => c.column_name);
        const select = [`"${version_column}" AS version`];
        if (colNames.includes(name_column)) select.push(`"${name_column}" AS name`);
        const r = await db.query(
          `SELECT ${select.join(', ')} FROM "${tracking_schema}"."${tracking_table}" ORDER BY 1;`,
        );
        return ok({ count: r.rowCount, migrations: r.rows });
      } catch (e) {
        return err(`migration_diff failed: ${e.message}`);
      }
    },
  );
}
