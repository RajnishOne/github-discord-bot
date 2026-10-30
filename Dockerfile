# Multi-stage production Dockerfile for GitHub Discord Bot
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Final runtime image
FROM node:22-alpine AS runner

# Install su-exec to support PUID/PGID and drop root privileges dynamically
RUN apk add --no-cache su-exec

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    PUID=1000 \
    PGID=100

# Create data directory
RUN mkdir -p /app/data

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/
COPY bin/ ./bin/
COPY public/ ./public/
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Expose port
EXPOSE 3000

# Mount persistent data directory
VOLUME ["/app/data"]

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'fetch("http://localhost:3000/health").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

# Automatically fixes host volume permissions based on PUID/PGID then drops root privileges
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
