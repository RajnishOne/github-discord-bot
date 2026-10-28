# Multi-stage production Dockerfile for GitHub Discord Bot
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Final runtime image
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

# Create data directory and assign ownership to non-root node user
RUN mkdir -p /app/data && chown -R node:node /app

# Copy dependencies from builder
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node src/ ./src/
COPY --chown=node:node bin/ ./bin/
COPY --chown=node:node public/ ./public/

# Switch to non-root user
USER node

# Expose port
EXPOSE 3000

# Mount persistent data directory
VOLUME ["/app/data"]

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'fetch("http://localhost:3000/health").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

# Start GitHub Discord Bot
CMD ["node", "src/server.js"]
