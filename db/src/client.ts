import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

export function createPgAdapter(connectionString: string) {
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  return { adapter, pool };
}
