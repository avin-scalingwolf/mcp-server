# ScalingWolf MCP Gateway

Internal MCP gateway over a Supabase/Postgres database. Exposes inspection, query, mutation, and migration tools over both Streamable HTTP (preferred) and legacy SSE transports. Intended for use as a back-end tool surface for internal agents (Claude Code, Antigravity, etc.) — not for external/public use.

## Setup

1. Copy `.env.example` to `.env` and set `DATABASE_URL` and `MCP_API_KEY`.
2. `npm install`
3. `npm start`

## HTTP endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | Liveness probe |
| `ALL` | `/mcp` | `x-api-key` | **Streamable HTTP** transport (preferred — Antigravity, current Claude Code) |
| `GET` | `/sse` | `x-api-key` | **SSE** transport handshake (legacy clients) |
| `POST` | `/message?sessionId=...` | `x-api-key` | SSE message channel |

Both transports run simultaneously and share the same tool surface. Each session is keyed by its own `sessionId` so multiple concurrent clients (testing + prod + hooks + chat) don't kick each other off.

## MCP tools

### Inspection (12)
- `list_schemas(include_internal?)` — schemas with table counts; hides Supabase-internal schemas by default
- `list_tables(schema?, include_internal?)`
- `describe_table(schema, table)` — columns, PK, FKs, indexes, triggers, RLS policies, row estimate
- `list_indexes(schema?, table?)` — with size
- `list_functions(schema?)`
- `list_views(schema?)` — views and materialized views
- `list_enums(schema?)` — enum types with values
- `list_sequences(schema?)`
- `list_policies(schema?, table?)` — RLS policies
- `list_triggers(schema?, table?)`
- `list_publications` — logical replication publications and tables
- `list_extensions`

### Query (5)
- `query(sql, params?)` — execute arbitrary SQL (no SELECT-only restriction)
- `sample_rows(schema, table, limit≤1000, where?, order_by?)`
- `row_count(schema, table, where?)`
- `explain(sql, analyze?, verbose?, format?)`
- `find_text(schema, table, column, pattern, limit≤500)` — ILIKE search

### Mutation (7)
- `execute(sql, params?)` — execute any SQL, returns rowCount + RETURNING rows
- `execute_tx(statements[])` — array of `{sql, params}` in a single transaction; rolls back on first error
- `insert_row(schema, table, values, returning?)`
- `update_rows(schema, table, set, where, where_params?, returning?)` — `where` required
- `delete_rows(schema, table, where, where_params?, returning?)` — `where` required
- `upsert_row(schema, table, values, on_conflict|on_conflict_constraint, update_columns?, returning?)`
- `truncate(schema, table, cascade?, restart_identity?)`

### Migrations (4)
- `list_migrations(schema?, table?, version_column?, name_column?, limit?)` — probes `supabase_migrations.schema_migrations`, `public.gorp_migrations`, `sys.migrations`, etc.
- `apply_migration(version, name?, sql, tracking_schema?, tracking_table?, record?)` — SQL + tracking row in one transaction
- `pending_migrations(expected[], tracking_schema?, tracking_table?, version_column?)` — diff a local migrations dir vs DB
- `migration_diff(tracking_schema?, tracking_table?, version_column?, name_column?)` — list applied versions; call on testing + prod to find drift

## Connecting clients

### Claude Code (SSE — current default)

```bash
claude mcp add scalingwolf-testing https://mcp.testing.scalingwolf.ai/sse \
  --transport sse --scope user \
  --header "x-api-key: <YOUR_KEY>"
```

### Antigravity (Streamable HTTP)

`~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "scalingwolf-testing": {
      "serverUrl": "https://mcp.testing.scalingwolf.ai/mcp",
      "headers": { "x-api-key": "<YOUR_KEY>" }
    }
  }
}
```

Note the URL ends in `/mcp` (Streamable HTTP), not `/sse`. Antigravity will not connect to the `/sse` endpoint correctly.

### Gemini CLI

```json
{
  "mcpServers": {
    "scalingwolf-testing": {
      "httpUrl": "https://mcp.testing.scalingwolf.ai/mcp",
      "headers": { "x-api-key": "<YOUR_KEY>" }
    }
  }
}
```

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | _required_ | Postgres DSN |
| `MCP_API_KEY` | _required_ | Bearer key for the `x-api-key` header |
| `PORT` | `3000` |  |
| `NODE_ENV` | `development` |  |
| `STATEMENT_TIMEOUT_MS` | `30000` | Per-statement timeout |
| `LOG_QUERIES` | `false` | When true, logs SSE/HTTP session lifecycle (does **not** log tool inputs) |

## Deployment

Designed for Coolify:
1. Connect this GitHub repo.
2. Set env vars `DATABASE_URL`, `MCP_API_KEY` (and optionally `STATEMENT_TIMEOUT_MS`).
3. Port `3000`.
4. Deploy.
