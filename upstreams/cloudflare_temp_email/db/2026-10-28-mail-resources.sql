CREATE TABLE IF NOT EXISTS raw_mail_resources (
    mail_id INTEGER PRIMARY KEY,
    version TEXT NOT NULL CHECK(length(version)=32 AND version NOT GLOB '*[^0-9a-f]*')
);

UPDATE raw_mail_resources SET version=lower(hex(randomblob(16))) WHERE
    (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='raw_mails'
        AND name IN ('raw_mail_resource_insert','raw_mail_resource_update','raw_mail_resource_delete')) != 3
    OR NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_delete_operations');

CREATE TABLE IF NOT EXISTS mail_delete_operations (
    address_id INTEGER NOT NULL, request_id TEXT NOT NULL, address TEXT NOT NULL,
    mail_id TEXT NOT NULL, expected_version TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('deleted','absent','changed')),
    created_at INTEGER NOT NULL, PRIMARY KEY(address_id,request_id)
);

CREATE TRIGGER IF NOT EXISTS raw_mail_resource_insert AFTER INSERT ON raw_mails BEGIN
    INSERT OR REPLACE INTO raw_mail_resources(mail_id,version) VALUES(NEW.id,lower(hex(randomblob(16))));
END;

CREATE TRIGGER IF NOT EXISTS raw_mail_resource_update AFTER UPDATE ON raw_mails BEGIN
    DELETE FROM raw_mail_resources WHERE mail_id=OLD.id;
    INSERT OR REPLACE INTO raw_mail_resources(mail_id,version) VALUES(NEW.id,lower(hex(randomblob(16))));
END;

CREATE TRIGGER IF NOT EXISTS raw_mail_resource_delete AFTER DELETE ON raw_mails BEGIN
    DELETE FROM raw_mail_resources WHERE mail_id=OLD.id;
END;

INSERT INTO raw_mail_resources(mail_id,version)
    SELECT id,lower(hex(randomblob(16))) FROM raw_mails WHERE 1
    ON CONFLICT(mail_id) DO NOTHING;
