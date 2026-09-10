"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPgAdapter = createPgAdapter;
const adapter_pg_1 = require("@prisma/adapter-pg");
const pg_1 = require("pg");
function createPgAdapter(connectionString) {
    const pool = new pg_1.Pool({ connectionString });
    const adapter = new adapter_pg_1.PrismaPg(pool);
    return { adapter, pool };
}
//# sourceMappingURL=client.js.map