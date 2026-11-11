FROM node:22-bookworm-slim

# System deps: git for diffing, ca-certificates for HTTPS to the model provider
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode CLI globally
RUN npm install -g opencode-ai@latest

WORKDIR /app

# Install app dependencies first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source + OpenCode provider config
COPY opencode.json review.config.json ./
COPY src ./src
COPY scripts ./scripts
COPY skills ./skills

# OpenCode looks for config in the working dir / XDG config dir.
# Place a global copy so `opencode run` picks up the DeepSeek provider anywhere.
RUN mkdir -p /root/.config/opencode \
    && cp /app/opencode.json /root/.config/opencode/opencode.json

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    REPO_DIR=/repo \
    OPENCODE_CONFIG=/app/opencode.json

EXPOSE 3000

# Default: web dashboard (standalone batch review).
# CI usage overrides the command, e.g.:
#   docker run ... opencodereviewer node src/cli.js ci
CMD ["node", "src/server.js"]
