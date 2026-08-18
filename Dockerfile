# Multi-stage build for smaller production image
FROM oven/bun:1-slim AS builder

WORKDIR /app

# Copy package files for better caching
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies for build)
RUN --mount=type=cache,target=/root/.bun/install/cache bun install

# Copy source code
COPY . .

# Production stage
FROM oven/bun:1-slim AS release

WORKDIR /app

# Copy necessary files from builder
COPY --from=builder /app/*.js /app/
COPY --from=builder /app/package.json /app/
COPY --from=builder /app/bun.lock /app/

# Set environment variables for HTTP mode (default for Coolify)
ENV TRANSPORT_TYPE=http
ENV HTTP_PORT=3000
ENV NODE_ENV=production

# Install curl and production dependencies
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/* && \
    bun install --production --ignore-scripts

# Expose port (Coolify will handle port mapping)
EXPOSE 3000

# Start the server
CMD ["bun", "server.js"]
