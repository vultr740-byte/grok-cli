FROM oven/bun:1-debian

# Runtime tools the agent shells out to (git, ripgrep) plus jq for the entrypoint.
# python3/make/g++ are needed at install time: some transitive deps (e.g.
# utf-8-validate via @coinbase/agentkit) compile native addons through node-gyp.
# ffmpeg is used by the Weixin bridge to normalize/transcode outbound images
# before CDN upload; it falls back to the original file when unavailable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        jq \
        ripgrep \
        ffmpeg \
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

# Weixin bridge (used when GROK_ENABLED_CHANNEL=weixin). Bun runs its TypeScript
# directly; install its runtime deps only (dev deps like tsc/tsx aren't needed).
COPY grok-weixin-bridge/package.json grok-weixin-bridge/tsconfig.json ./grok-weixin-bridge/
COPY grok-weixin-bridge/src ./grok-weixin-bridge/src
RUN cd grok-weixin-bridge && bun install --production

# Grok reads config/sessions from $HOME/.grok. Point HOME at the mounted
# volume so pairing approvals and sessions survive redeploys. Set it AFTER
# `bun install` so the build still uses the image's default cache location.
ENV HOME=/data
ENV NODE_ENV=production

CMD ["docker/entrypoint.sh"]
