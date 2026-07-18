FROM oven/bun:1-debian

# Runtime tools the agent shells out to (git, ripgrep) plus jq for the entrypoint.
# python3/make/g++ are needed at install time: some transitive deps (e.g.
# utf-8-validate via @coinbase/agentkit) compile native addons through node-gyp.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        jq \
        ripgrep \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so this layer caches across source changes.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Application source (Bun runs the TypeScript directly — no build step).
COPY tsconfig.json ./
COPY src ./src
COPY docker ./docker
RUN chmod +x docker/entrypoint.sh

# Grok reads config/sessions from $HOME/.grok. Point HOME at the mounted
# volume so pairing approvals and sessions survive redeploys. Set it AFTER
# `bun install` so the build still uses the image's default cache location.
ENV HOME=/data
ENV NODE_ENV=production

CMD ["docker/entrypoint.sh"]
