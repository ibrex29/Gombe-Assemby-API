# syntax=docker/dockerfile:1

# Electromon Migrate — one-shot migration container (build context: api project root)
# Does not compile bcrypt (seed-only devDependency). Production sets RUN_SEED=false.

FROM node:20-alpine
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
RUN apk add --no-cache libc6-compat netcat-openbsd openssl

WORKDIR /app

COPY db/package.json db/pnpm-lock.yaml db/prisma.config.ts db/tsconfig.json ./
COPY db/prisma ./prisma/

# Skip lifecycle scripts: bcrypt's node-gyp build needs Python and is unused here.
RUN pnpm install --frozen-lockfile --ignore-scripts

# Prisma 7 loads prisma.config.ts at generate time; a dummy URL is enough (no DB connect).
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public" npx prisma generate

COPY infra/scripts/entrypoint-migrate.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
