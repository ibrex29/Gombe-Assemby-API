# Testing

## API tests (this repo)

```bash
pnpm test              # unit tests
pnpm test:e2e          # HTTP e2e tests
pnpm test:cov          # coverage report
```

Or via Makefile:

```bash
make test
make test-e2e
```

## Prerequisites

Build local packages before running tests:

```bash
pnpm db:generate && pnpm shared:build && pnpm db:build
```

## Unit tests

**Location:** `src/**/*.spec.ts`

- Mocked `PrismaService` — `test/helpers/prisma.mock.ts`
- Shared fixtures — `test/helpers/fixtures.ts`

```bash
pnpm test
```

## E2E tests

**Location:** `test/**/*.e2e-spec.ts`

HTTP tests use **Supertest** against a slim `E2eTestModule` with mocked Postgres and Redis (`test/helpers/test-app.ts`).

```bash
pnpm test:e2e
```

## Web tests

The dashboard has its own test suite in [electromon-web](https://github.com/ibrex29/electromon-web):

```bash
git clone git@github.com:ibrex29/electromon-web.git
cd electromon-web
pnpm test
```

## Layout

```
test/
├── api.e2e-spec.ts
├── helpers/
│   ├── e2e.module.ts
│   ├── fixtures.ts
│   ├── prisma.mock.ts
│   └── test-app.ts
├── jest-e2e.json
└── setup-e2e.ts
```

After schema changes:

```bash
pnpm db:generate && pnpm db:build
```
