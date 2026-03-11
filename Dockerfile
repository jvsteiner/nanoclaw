# NanoClaw Orchestrator
# Multi-stage build: compile TypeScript, then run with production deps only.

# --- Build stage ---
FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
COPY catalog/tsconfig.json ./catalog/
COPY catalog/channels/ ./catalog/channels/
RUN npx tsc && npx tsc -p catalog/tsconfig.json

# --- Production stage ---
FROM node:22-slim

RUN apt-get update && apt-get install -y \
    curl \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm rebuild better-sqlite3 \
    && apt-get purge -y python3 make g++ && apt-get autoremove -y

# Copy compiled JS from build stage
COPY --from=build /app/dist/ ./dist/

# Copy container assets the orchestrator syncs into per-group dirs
COPY container/agent-runner/src/ ./container/agent-runner/src/

# Copy compiled channel catalog (platform-provided, not tenant-specific)
COPY --from=build /app/catalog/dist/ ./catalog/dist/

USER node

EXPOSE 3000

CMD ["node", "--dns-result-order=ipv4first", "--no-network-family-autoselection", "dist/index.js"]
