FROM node:26-bookworm-slim

# System deps: git for diffing, ca-certificates for HTTPS to the model provider
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install app dependencies first for better layer caching. This includes the
# OpenCode CLI at the exact version pinned in package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
ENV PATH=/app/node_modules/.bin:$PATH

# App source + OpenCode provider config
COPY opencode.json review.config.json ./
COPY src ./src
RUN ln -s /app/src/cli.js /usr/local/bin/opencodereviewer
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
    DATA_DIR=/data \
    OPENCODE_CONFIG=/app/opencode.json

# Password hash now; settings and review history later.
VOLUME /data

EXPOSE 3000

# Default: web dashboard (standalone batch review).
# CI usage overrides the command, e.g.:
#   docker run ... opencodereviewer opencodereviewer ci
CMD ["node", "src/server.js"]
