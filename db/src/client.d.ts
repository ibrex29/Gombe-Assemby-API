import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
export declare function createPgAdapter(connectionString: string): {
    adapter: PrismaPg;
    pool: Pool;
};
