# Batman server image (spec Section 17, Option B: always-on host).
# One process, outbound connections only, SQLite on a mounted volume at /app/data.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /app

# Install dependencies first for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/probe/package.json apps/probe/package.json
RUN pnpm install --frozen-lockfile

COPY . .

# Never bake secrets into the image; they come from Fly secrets at runtime.
RUN rm -f .env .env.* || true

# SQLite lives on the volume mounted here (DATABASE_PATH=./data/... resolves to /app/data).
VOLUME ["/app/data"]

CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
