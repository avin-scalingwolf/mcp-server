# ScalingWolf MCP Gateway

Internal MCP gateway over a Supabase/Postgres database. Exposes inspection and query tools over an SSE transport. Intended for use as a back-end tool surface for internal agents (Claude Code, etc.) — not for external/public use.

## Setup

1. Copy `.env.example` to `.env` and set `DATABASE_URL` and `MCP_API_KEY`.
2. `npm install`
3. `npm start`

## HTTP endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | Liveness probe |
| `GET` | `/sse` | `x-api-key` header | MCP SSE transport handshake |
| `POST` | `/message?sessionId=...` | `x-api-key` header | MCP message channel for an SSE session |

Multiple SSE clients can connect concurrently — each gets its own `sessionId`-keyed transport.

## MCP tools

### Inspection
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

### Query
- `query(sql, params?)` — execute arbitrary SQL (no SELECT-only restriction)
- `sample_rows(schema, table, limit≤1000, where?, order_by?)`
- `row_count(schema, table, where?)`
- `explain(sql, analyze?, verbose?, format?)`
- `find_text(schema, table, column, pattern, limit≤500)` — ILIKE search

## Connecting Claude Code

```bash
claude mcp add scalingwolf-testing https://mcp.testing.scalingwolf.ai/sse \
  --transport sse --scope user \
  --header "x-api-key: <YOUR_KEY>"
```

Restart your session, then the tools surface as `mcp__scalingwolf-testing__list_tables`, etc.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | _required_ | Postgres DSN |
| `MCP_API_KEY` | _required_ | Bearer key for the `x-api-key` header |
| `PORT` | `3000` |  |
| `NODE_ENV` | `development` |  |
| `STATEMENT_TIMEOUT_MS` | `30000` | Per-statement timeout |
| `LOG_QUERIES` | `false` | When true, logs SSE session lifecycle (does **not** log tool inputs) |

## Deployment

Designed for Coolify:
1. Connect this GitHub repo.
2. Set env vars `DATABASE_URL`, `MCP_API_KEY` (and optionally `STATEMENT_TIMEOUT_MS`).
3. Port `3000`.
4. Deploy.
