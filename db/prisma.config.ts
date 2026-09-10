import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// `prisma generate` runs at Docker build time with no real DB. env('DATABASE_URL')
// throws PrismaConfigEnvError in that case. Runtime still uses DATABASE_URL.
const datasourceUrl =
  process.env.DATABASE_URL ??
  'postgresql://build:build@127.0.0.1:5432/build?schema=public';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx --env-file=.env --env-file=../.env prisma/seed.ts',
  },
  datasource: {
    url: datasourceUrl,
  },
});
