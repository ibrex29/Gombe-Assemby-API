# syntax=docker/dockerfile:1

# One-shot Pantamiyya bootstrap seed (Gombe geography + governorship campaign).

FROM node:20-alpine
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
RUN apk add --no-cache libc6-compat openssl python3 make g++ netcat-openbsd

WORKDIR /app/db

COPY db/package.json db/pnpm-lock.yaml db/prisma.config.ts db/tsconfig.json ./
COPY db/prisma ./prisma/
COPY db/src ./src/
COPY shared/package.json shared/pnpm-lock.yaml /app/shared/
COPY shared/tsconfig.json /app/shared/tsconfig.json
COPY shared/src /app/shared/src

RUN pnpm install --frozen-lockfile \
  && pnpm --dir /app/shared install --frozen-lockfile \
  && pnpm --dir /app/shared build \
  && mkdir -p node_modules/@electromon \
  && ln -sfn /app/db node_modules/@electromon/db

RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public" npx prisma generate \
  && pnpm build

COPY infra/scripts/entrypoint-pantamiyya-seed.sh /entrypoint.sh
COPY infra/scripts/entrypoint-pantamiyya-sha.sh /entrypoint-sha.sh
RUN chmod +x /entrypoint.sh /entrypoint-sha.sh

WORKDIR /app/db
ENTRYPOINT ["/entrypoint.sh"]
