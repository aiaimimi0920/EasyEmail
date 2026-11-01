export const MAIL_RESOURCE_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS raw_mail_resources (
        mail_id INTEGER PRIMARY KEY,
        version TEXT NOT NULL CHECK(length(version)=32 AND version NOT GLOB '*[^0-9a-f]*')
    )`,
    `UPDATE raw_mail_resources SET version=lower(hex(randomblob(16))) WHERE
        (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='raw_mails'
            AND name IN ('raw_mail_resource_insert','raw_mail_resource_update','raw_mail_resource_delete')) != 3
        OR NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_delete_operations')`,
    `CREATE TABLE IF NOT EXISTS mail_delete_operations (
        address_id INTEGER NOT NULL, request_id TEXT NOT NULL, address TEXT NOT NULL,
        mail_id TEXT NOT NULL, expected_version TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('deleted','absent','changed')),
        created_at INTEGER NOT NULL, PRIMARY KEY(address_id,request_id)
    )`,
    `CREATE TRIGGER IF NOT EXISTS raw_mail_resource_insert AFTER INSERT ON raw_mails BEGIN
        INSERT OR REPLACE INTO raw_mail_resources(mail_id,version) VALUES(NEW.id,lower(hex(randomblob(16))));
    END`,
    `CREATE TRIGGER IF NOT EXISTS raw_mail_resource_update AFTER UPDATE ON raw_mails BEGIN
        DELETE FROM raw_mail_resources WHERE mail_id=OLD.id;
        INSERT OR REPLACE INTO raw_mail_resources(mail_id,version) VALUES(NEW.id,lower(hex(randomblob(16))));
    END`,
    `CREATE TRIGGER IF NOT EXISTS raw_mail_resource_delete AFTER DELETE ON raw_mails BEGIN
        DELETE FROM raw_mail_resources WHERE mail_id=OLD.id;
    END`,
    `INSERT INTO raw_mail_resources(mail_id,version)
        SELECT id,lower(hex(randomblob(16))) FROM raw_mails WHERE 1
        ON CONFLICT(mail_id) DO NOTHING`,
] as const;

export async function migrateMailResources(db: D1Database): Promise<void> {
    // Rotate potentially stale tokens and restore missing triggers in one atomic batch.
    await db.batch(MAIL_RESOURCE_SCHEMA.map((sql) => db.prepare(sql)));
}

export async function mailResourcesReady(db: D1Database): Promise<boolean> {
    const { results } = await db.prepare(`SELECT sql FROM sqlite_master WHERE name IN
        ('raw_mail_resources','mail_delete_operations','raw_mail_resource_insert','raw_mail_resource_update','raw_mail_resource_delete')`)
        .all<{ sql: string }>();
    // Missing or stale triggers must never advertise a version that survives content changes.
    const normalize = (sql: string) => sql.replace(/IF NOT EXISTS/gi, '').replace(/\s+/g, '').replace(/;$/g, '').toLowerCase();
    const actual = new Set(results.map((row) => normalize(row.sql)));
    return MAIL_RESOURCE_SCHEMA.filter((sql) => /^CREATE (TABLE|TRIGGER)/.test(sql)).every((sql) => actual.has(normalize(sql)));
}

export async function resourceMailQuery(db: D1Database): Promise<string> {
    // Read content and its generation in one SQLite snapshot, not two independent reads.
    return await mailResourcesReady(db)
        ? 'SELECT r.*,v.version AS resource_version FROM raw_mails r LEFT JOIN raw_mail_resources v ON v.mail_id=r.id'
        : 'SELECT r.* FROM raw_mails r';
}
