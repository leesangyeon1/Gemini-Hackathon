# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Build client (Vite) and server (Vite SSR -> dist/server/index.js)
# ==============================================================================
FROM node:24-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# ==============================================================================
# Stage 2: Minimal non-root production runtime (0.0.0.0:$PORT, default 8080)
# ==============================================================================
FROM node:24-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --chown=node:node package.json package-lock.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

# Ensure optional local SQLite directory is writable by non-root `node` if sqlite mode is used
RUN mkdir -p /app/.data && chown -R node:node /app/.data

USER node

EXPOSE 8080

CMD ["node", "dist/server/index.js"]
