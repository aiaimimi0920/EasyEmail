export const ADDRESS_DELETION_SCHEMA = `CREATE TABLE IF NOT EXISTS address_delete_operations (
    address_id INTEGER NOT NULL, request_id TEXT NOT NULL, address TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('deleted','absent','changed')),
    batch_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(address_id,request_id)
)`;

export async function migrateAddressDeletions(db: D1Database): Promise<void> {
    await db.prepare(ADDRESS_DELETION_SCHEMA).run();
}

export async function addressDeletionsReady(db: D1Database): Promise<boolean> {
    const { results } = await db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='table'
        AND name IN ('address_delete_operations','address')`).all<{ name: string; sql: string }>();
    const normalize = (sql: string) => sql.replace(/IF NOT EXISTS/gi, '').replace(/\s+/g, '').replace(/;$/g, '').toLowerCase();
    const table = results.find((row) => row.name === 'address_delete_operations');
    const address = results.find((row) => row.name === 'address');
    // Normal creation/transfer must not reuse a deleted address ID.
    return !!table && normalize(table.sql) === normalize(ADDRESS_DELETION_SCHEMA)
        && !!address && /id\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i.test(address.sql);
}
