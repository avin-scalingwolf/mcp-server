import { z } from 'zod';

const HIDDEN_SCHEMAS = [
  'information_schema',
  'pg_catalog',
  'pg_toast',
  'auth',
  'realtime',
  'storage',
  'vault',
  'extensions',
  'graphql',
  'graphql_public',
  'supabase_functions',
  'supabase_migrations',
  'net',
  'pgsodium',
  'pgsodium_masks',
  'cron',
];

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function schemaFilter(includeInternal) {
  return includeInternal
    ? `table_schema NOT IN ('information_schema','pg_catalog','pg_toast')`
    : `table_schema NOT IN (${HIDDEN_SCHEMAS.map((s) => `'${s}'`).join(',')})`;
}

export function register(mcp, db) {
  mcp.tool(
    'list_schemas',
    'List database schemas with table counts. Hides Supabase-internal schemas unless include_internal=true.',
    { include_internal: z.boolean().optional().default(false) },
    async ({ include_internal }) => {
      try {
        const r = await db.query(
          `
          SELECT n.nspname AS schema,
                 (SELECT count(*) FROM information_schema.tables t
                    WHERE t.table_schema = n.nspname) AS table_count
          FROM pg_namespace n
          WHERE n.nspname NOT LIKE 'pg_%'
            AND n.nspname <> 'information_schema'
            ${include_internal ? '' : `AND n.nspname NOT IN (${HIDDEN_SCHEMAS.map((s) => `'${s}'`).join(',')})`}
          ORDER BY n.nspname;
          `,
        );
        return ok({ schemas: r.rows });
      } catch (e) {
        return err(`list_schemas failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'list_tables',
    'List tables. Filter by schema; hides Supabase-internal schemas unless include_internal=true.',
    {
      schema: z.string().optional(),
      include_internal: z.boolean().optional().default(false),
    },
    async ({ schema, include_internal }) => {
      try {
        const params = [];
        let where = schemaFilter(include_internal);
        if (schema) {
          params.push(schema);
          where = `table_schema = $1`;
        }
        const r = await db.query(
          `
          SELECT table_schema, table_name, table_type
          FROM information_schema.tables
          WHERE ${where}
          ORDER BY table_schema, table_name;
          `,
          params,
        );
        return ok({ tables: r.rows });
      } catch (e) {
        return err(`list_tables failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'describe_table',
    'Full description of a table: columns, types, PK, FKs, indexes, triggers, RLS policies, and row estimate.',
    {
      schema: z.string(),
      table: z.string(),
    },
    async ({ schema, table }) => {
      try {
        const [columns, pk, fks, indexes, triggers, policies, rowEstimate] = await Promise.all([
          db.query(
            `
            SELECT column_name, data_type, udt_name, is_nullable, column_default,
                   character_maximum_length, numeric_precision, numeric_scale, ordinal_position
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position;
            `,
            [schema, table],
          ),
          db.query(
            `
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
            WHERE tc.table_schema = $1 AND tc.table_name = $2
              AND tc.constraint_type = 'PRIMARY KEY'
            ORDER BY kcu.ordinal_position;
            `,
            [schema, table],
          ),
          db.query(
            `
            SELECT
              tc.constraint_name,
              kcu.column_name,
              ccu.table_schema AS foreign_schema,
              ccu.table_name AS foreign_table,
              ccu.column_name AS foreign_column,
              rc.update_rule,
              rc.delete_rule
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name
             AND ccu.table_schema = tc.table_schema
            JOIN information_schema.referential_constraints rc
              ON rc.constraint_name = tc.constraint_name
             AND rc.constraint_schema = tc.table_schema
            WHERE tc.table_schema = $1 AND tc.table_name = $2
              AND tc.constraint_type = 'FOREIGN KEY'
            ORDER BY tc.constraint_name, kcu.ordinal_position;
            `,
            [schema, table],
          ),
          db.query(
            `
            SELECT indexname AS name, indexdef AS definition
            FROM pg_indexes
            WHERE schemaname = $1 AND tablename = $2
            ORDER BY indexname;
            `,
            [schema, table],
          ),
          db.query(
            `
            SELECT trigger_name, event_manipulation, action_timing, action_statement
            FROM information_schema.triggers
            WHERE event_object_schema = $1 AND event_object_table = $2
            ORDER BY trigger_name;
            `,
            [schema, table],
          ),
          db.query(
            `
            SELECT policyname AS name, cmd, permissive, roles, qual, with_check
            FROM pg_policies
            WHERE schemaname = $1 AND tablename = $2
            ORDER BY policyname;
            `,
            [schema, table],
          ),
          db.query(
            `
            SELECT reltuples::bigint AS estimated_rows
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2;
            `,
            [schema, table],
          ),
        ]);

        if (columns.rows.length === 0) {
          return err(`Table ${schema}.${table} not found.`);
        }

        return ok({
          schema,
          table,
          columns: columns.rows,
          primary_key: pk.rows.map((r) => r.column_name),
          foreign_keys: fks.rows,
          indexes: indexes.rows,
          triggers: triggers.rows,
          rls_policies: policies.rows,
          estimated_rows: rowEstimate.rows[0]?.estimated_rows ?? null,
        });
      } catch (e) {
        return err(`describe_table failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'list_indexes',
    'List indexes, optionally filtered by schema and/or table. Includes size.',
    {
      schema: z.string().optional(),
      table: z.string().optional(),
    },
    async ({ schema, table }) => {
      try {
        const conds = [];
        const params = [];
        if (schema) { params.push(schema); conds.push(`n.nspname = $${params.length}`); }
        if (table) { params.push(table); conds.push(`c.relname = $${params.length}`); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const r = await db.query(
          `
          SELECT n.nspname AS schema,
                 c.relname AS table,
                 i.relname AS index,
                 pg_size_pretty(pg_relation_size(i.oid)) AS size,
                 ix.indisunique AS is_unique,
                 ix.indisprimary AS is_primary,
                 pg_get_indexdef(i.oid) AS definition
          FROM pg_index ix
          JOIN pg_class c ON c.oid = ix.indrelid
          JOIN pg_class i ON i.oid = ix.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          ${where}
          ORDER BY n.nspname, c.relname, i.relname;
          `,
          params,
        );
        return ok({ indexes: r.rows });
      } catch (e) {
        return err(`list_indexes failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'list_functions',
    'List user-defined functions and procedures with signatures and return type.',
    { schema: z.string().optional() },
    async ({ schema }) => {
      try {
        const params = [];
        let where = `n.nspname NOT IN (${HIDDEN_SCHEMAS.map((s) => `'${s}'`).join(',')}) AND n.nspname NOT LIKE 'pg_%'`;
        if (schema) {
          params.push(schema);
          where = `n.nspname = $1`;
        }
        const r = await db.query(
          `
          SELECT n.nspname AS schema,
                 p.proname AS name,
                 pg_get_function_identity_arguments(p.oid) AS arguments,
                 pg_get_function_result(p.oid) AS returns,
                 CASE p.prokind WHEN 'f' THEN 'function' WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window' END AS kind,
                 l.lanname AS language
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_language l ON l.oid = p.prolang
          WHERE ${where}
          ORDER BY n.nspname, p.proname;
          `,
          params,
        );
        return ok({ functions: r.rows });
      } catch (e) {
        return err(`list_functions failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'list_views',
    'List views and materialized views.',
    { schema: z.string().optional() },
    async ({ schema }) => {
      try {
        const params = [];
        let where = `schemaname NOT IN (${HIDDEN_SCHEMAS.map((s) => `'${s}'`).join(',')})`;
        if (schema) {
          params.push(schema);
          where = `schemaname = $1`;
        }
        const r = await db.query(
          `
          SELECT schemaname AS schema, viewname AS name, 'view' AS kind
          FROM pg_views WHERE ${where}
          UNION ALL
          SELECT schemaname AS schema, matviewname AS name, 'materialized_view' AS kind
          FROM pg_matviews WHERE ${where}
          ORDER BY schema, name;
          `,
          params,
        );
        return ok({ views: r.rows });
      } catch (e) {
        return err(`list_views failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'list_enums',
    'List enum types and their values.',
    { schema: z.string().optional() },
    async ({ schema }) => {
      try {
        const params = [];
        let where = `n.nspname NOT IN (${HIDDEN_SCHEMAS.map((s) => `'${s}'`).join(',')})`;
        if (schema) {
          params.push(schema);
          where = `n.nspname = $1`;
        }
        const r = await db.query(
          `
          SELECT n.nspname AS schema,
                 t.typname AS name,
                 array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
          FROM pg_type t
          JOIN pg_enum e ON e.enumtypid = t.oid
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE ${where}
          GROUP BY n.nspname, t.typname
          ORDER BY n.nspname, t.typname;
          `,
          params,
        );
        return ok({ enums: r.rows });
      } catch (e) {
        return err(`list_enums failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'list_sequences',
    'List sequences with current and last values.',
    { schema: z.string().optional() },
    async ({ schema }) => {
      try {
        const params = [];
        let where = `sequence_schema NOT IN (${HIDDEN_SCHEMAS.map((s) => `'${s}'`).join(',')})`;
        if (schema) {
          params.push(schema);
          where = `sequence_schema = $1`;
        }
        const r = await db.query(
          `
          SELECT sequence_schema AS schema,
                 sequence_name AS name,
                 data_type,
                 start_value,
                 minimum_value,
                 maximum_value,
                 increment
          FROM information_schema.sequences
          WHERE ${where}
          ORDER BY sequence_schema, sequence_name;
          `,
          params,
        );
        return ok({ sequences: r.rows });
      } catch (e) {
        return err(`list_sequences failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'list_policies',
    'List RLS policies, optionally filtered by schema and/or table.',
    {
      schema: z.string().optional(),
      table: z.string().optional(),
    },
    async ({ schema, table }) => {
      try {
        const conds = [];
        const params = [];
        if (schema) { params.push(schema); conds.push(`schemaname = $${params.length}`); }
        if (table) { params.push(table); conds.push(`tablename = $${params.length}`); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const r = await db.query(
          `
          SELECT schemaname AS schema, tablename AS table, policyname AS name,
                 permissive, roles, cmd, qual, with_check
          FROM pg_policies
          ${where}
          ORDER BY schemaname, tablename, policyname;
          `,
          params,
        );
        return ok({ policies: r.rows });
      } catch (e) {
        return err(`list_policies failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'list_triggers',
    'List triggers, optionally filtered by schema and/or table.',
    {
      schema: z.string().optional(),
      table: z.string().optional(),
    },
    async ({ schema, table }) => {
      try {
        const conds = [];
        const params = [];
        if (schema) { params.push(schema); conds.push(`event_object_schema = $${params.length}`); }
        if (table) { params.push(table); conds.push(`event_object_table = $${params.length}`); }
        const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
        const r = await db.query(
          `
          SELECT event_object_schema AS schema,
                 event_object_table AS table,
                 trigger_name AS name,
                 action_timing,
                 event_manipulation,
                 action_statement
          FROM information_schema.triggers
          ${where}
          ORDER BY schema, table, name;
          `,
          params,
        );
        return ok({ triggers: r.rows });
      } catch (e) {
        return err(`list_triggers failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'list_publications',
    'List logical replication publications and their tables (used by Supabase Realtime).',
    {},
    async () => {
      try {
        const [pubs, tables] = await Promise.all([
          db.query(`SELECT pubname, puballtables, pubinsert, pubupdate, pubdelete, pubtruncate FROM pg_publication ORDER BY pubname;`),
          db.query(`SELECT pubname, schemaname, tablename FROM pg_publication_tables ORDER BY pubname, schemaname, tablename;`),
        ]);
        return ok({ publications: pubs.rows, tables: tables.rows });
      } catch (e) {
        return err(`list_publications failed: ${e.message}`);
      }
    },
  );

  mcp.tool(
    'list_extensions',
    'List installed PostgreSQL extensions with versions.',
    {},
    async () => {
      try {
        const r = await db.query(
          `SELECT extname AS name, extversion AS version, n.nspname AS schema
           FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
           ORDER BY extname;`,
        );
        return ok({ extensions: r.rows });
      } catch (e) {
        return err(`list_extensions failed: ${e.message}`);
      }
    },
  );
}
