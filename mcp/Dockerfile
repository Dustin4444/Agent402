# Dockerfile for the agent402-mcp stdio server - written for Glama's built-
# server evaluation (glama.ai builds this and checks the server starts and
# answers MCP introspection over stdio; no keys are needed for that, the
# catalog loads from the hosted API and payment credentials are only read
# when a paid call is attempted).
#
# Kept in mcp/ ON PURPOSE: a repo-root Dockerfile would be auto-detected by
# Railway and silently replace the Railpack build that deploys production.
# Build context is this directory: docker build -t agent402-mcp mcp/
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js networks.js README.md ./
ENTRYPOINT ["node", "index.js"]
