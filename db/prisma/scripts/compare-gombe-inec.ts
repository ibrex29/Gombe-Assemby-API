/**
 * Compare Gombe local register vs INEC portal PU list.
 * Run: pnpm --dir db exec tsx --env-file=.env --env-file=../.env prisma/scripts/compare-gombe-inec.ts
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../../src/generated/client';
import { createPgAdapter } from '../../src/client';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
config({ path: resolve(__dirname, '../../.env') });
config({ path: resolve(__dirname, '../../../.env') });

const ELECTION_ID = '6407d9bfce35006e92156f2e';
const STATE_INEC = '16';

function norm(code: string) {
  return code.replace(/\//g, '-').toUpperCase();
}

async function fetchInecPus(): Promise<Map<string, { name: string; hasDoc: boolean }>> {
  const bases = [
    'https://lv001-r.inecelectionresults.ng/api/v1',
    'https://lv001-g.inecelectionresults.ng/api/v1',
  ];
  let lastError: unknown;
  for (const base of bases) {
    try {
      const url = `${base}/elections/${ELECTION_ID}/pus?state=${STATE_INEC}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`${res.status}`);
      const body = (await res.json()) as { data?: unknown[] } | unknown[];
      const rows = Array.isArray(body) ? body : (body.data ?? []);
      const map = new Map<string, { name: string; hasDoc: boolean }>();
      for (const row of rows as Array<Record<string, unknown>>) {
        const del = String(row.delimitation ?? row.code ?? '').trim();
        if (!del) continue;
        map.set(norm(del), {
          name: String(row.name ?? row.pollingUnitName ?? ''),
          hasDoc: Boolean(row.documentUrl ?? row.hasDocument ?? row.uploaded),
        });
      }
      console.log(`INEC API (${base}): ${map.size} PUs`);
      return map;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function main() {
  const cs = process.env.DATABASE_URL!.replace(/\?schema=.*/, '');
  const { adapter, pool } = createPgAdapter(cs);
  const prisma = new PrismaClient({ adapter });

  try {
    const localPus = await prisma.pollingUnit.findMany({
      where: { ward: { lga: { state: { code: 'GO' } } } },
      select: {
        code: true,
        name: true,
        irevSnapshots: {
          select: { status: true, documentUrl: true },
          take: 1,
        },
      },
    });
    const local = new Map(localPus.map((pu) => [norm(pu.code), pu]));
    console.log(`Local register: ${local.size} PUs`);

    const inec = await fetchInecPus();
    const inecOnly: string[] = [];
    const localOnly: string[] = [];
    const inecDocNotCatalogued: string[] = [];

    for (const [code, meta] of inec) {
      if (!local.has(code)) inecOnly.push(`${code} · ${meta.name}`);
      else if (meta.hasDoc) {
        const pu = local.get(code)!;
        const snap = pu.irevSnapshots[0];
        if (!snap?.documentUrl) inecDocNotCatalogued.push(`${code} · ${pu.name}`);
      }
    }
    for (const code of local.keys()) {
      if (!inec.has(code)) localOnly.push(code);
    }

    console.log(`\nINEC only (${inecOnly.length}):`);
    inecOnly.slice(0, 20).forEach((row) => console.log(' ', row));
    if (inecOnly.length > 20) console.log(`  … +${inecOnly.length - 20} more`);

    console.log(`\nLocal only (${localOnly.length}):`);
    localOnly.slice(0, 20).forEach((row) => console.log(' ', row));

    console.log(`\nINEC has doc, we have PU but no catalog (${inecDocNotCatalogued.length}):`);
    inecDocNotCatalogued.slice(0, 20).forEach((row) => console.log(' ', row));
    if (inecDocNotCatalogued.length > 20) console.log(`  … +${inecDocNotCatalogued.length - 20} more`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
