FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY src/ ./src/

ENV PORT=3000
EXPOSE 3000

# Health check for Coolify
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget --no-verbose --tries=1 --spider --header="x-api-key: $MCP_API_KEY" http://localhost:3000/health || exit 1

CMD ["npm", "start"]
