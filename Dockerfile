# Multi-stage build for smaller production image
FROM node:22.12-alpine AS builder

WORKDIR /app

# Copy package files for better caching
COPY package*.json ./

# Install all dependencies (including dev dependencies for build)
RUN --mount=type=cache,target=/root/.npm npm install

# Copy source code
COPY . .

# Production stage
FROM node:22-alpine AS release

WORKDIR /app

# Copy necessary files from builder
COPY --from=builder /app/server.js /app/
COPY --from=builder /app/browser_tools.js /app/
COPY --from=builder /app/browser_session.js /app/
COPY --from=builder /app/package*.json /app/

# Set environment variables for HTTP mode (default for Coolify)
ENV TRANSPORT_TYPE=http
ENV HTTP_PORT=3000
ENV NODE_ENV=production

# Install only production dependencies
RUN npm ci --ignore-scripts --omit=dev

# Expose port (Coolify will handle port mapping)
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
