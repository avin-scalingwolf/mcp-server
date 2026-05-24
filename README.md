# MCP Gateway Server

A production-ready MCP Gateway server for Supabase, exposing safe endpoints for external integrations.

## Setup

1. Copy `.env.example` to `.env` and configure your `DATABASE_URL`.
2. Run `npm install`
3. Run `npm start`

## Endpoints

- `GET /health` - Health check endpoint
- `GET /tables` - Lists available tables in the database
- `POST /query` - Executes safe `SELECT` queries. 
  - Body: `{ "query": "SELECT * FROM users", "params": [] }`

## Deployment

Designed to be deployed on Coolify.
1. Connect this GitHub repository.
2. Set Environment Variables (`DATABASE_URL`, `NODE_ENV`).
3. Set Port to `3000`.
4. Deploy!
