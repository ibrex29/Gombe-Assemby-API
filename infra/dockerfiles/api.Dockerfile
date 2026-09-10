# syntax=docker/dockerfile:1

# Electromon API — production image (build context: api project root)

FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
RUN apk add --no-cache libc6-compat

FROM base AS deps
WORKDIR /app

COPY pnpm-lock.yaml package.json .npmrc ./
COPY db/package.json db/pnpm-lock.yaml ./db/
COPY db/prisma.config.ts ./db/
COPY db/prisma ./db/prisma/
COPY shared/package.json ./shared/

RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app

COPY . .
# Root install does not put prisma on PATH; db/shared have their own node_modules
# (postinstall: pnpm --dir db install && pnpm --dir shared install).
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/db/node_modules ./db/node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules

# Prisma 7 requires DATABASE_URL while generating the client (build does not connect).
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"
RUN pnpm shared:build && pnpm db:build && pnpm build

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache wget poppler-utils \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nestjs

COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nestjs:nodejs /app/db ./db
COPY --from=builder --chown=nestjs:nodejs /app/shared ./shared

ENV NODE_PATH=/app/db/node_modules:/app/node_modules
ENV API_PORT=3002

COPY --chown=nestjs:nodejs infra/scripts/entrypoint-api.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
  && mkdir -p /app/uploads \
  && chown nestjs:nodejs /app/uploads

USER nestjs

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3002/api/v1/health/ready || exit 1

ENTRYPOINT ["/entrypoint.sh"]
