CREATE TABLE IF NOT EXISTS raw_mails (
    id INTEGER PRIMARY KEY,
    message_id TEXT,
    source TEXT,
    address TEXT,
    raw TEXT,
    raw_blob BLOB,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_raw_mails_address ON raw_mails(address);

CREATE INDEX IF NOT EXISTS idx_raw_mails_created_at ON raw_mails(created_at);

CREATE INDEX IF NOT EXISTS idx_raw_mails_message_id ON raw_mails(message_id);

CREATE TABLE IF NOT EXISTS address (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    password TEXT,
    source_meta TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_name ON address(name);

CREATE INDEX IF NOT EXISTS idx_address_created_at ON address(created_at);

CREATE INDEX IF NOT EXISTS idx_address_updated_at ON address(updated_at);

CREATE INDEX IF NOT EXISTS idx_address_source_meta ON address(source_meta);

CREATE TABLE IF NOT EXISTS auto_reply_mails (
    id INTEGER PRIMARY KEY,
    source_prefix TEXT,
    name TEXT,
    address TEXT UNIQUE,
    subject TEXT,
    message TEXT,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auto_reply_mails_address ON auto_reply_mails(address);

CREATE TABLE IF NOT EXISTS address_sender (
    id INTEGER PRIMARY KEY,
    address TEXT UNIQUE,
    balance INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_address_sender_address ON address_sender(address);

CREATE TABLE IF NOT EXISTS sendbox (
    id INTEGER PRIMARY KEY,
    address TEXT,
    raw TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sendbox_address ON sendbox(address);

CREATE INDEX IF NOT EXISTS idx_sendbox_created_at ON sendbox(created_at);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    user_email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    user_info TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_user_email ON users(user_email);

CREATE TABLE IF NOT EXISTS users_address (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    address_id INTEGER UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_address_user_id ON users_address(user_id);

CREATE INDEX IF NOT EXISTS idx_users_address_address_id ON users_address(address_id);

CREATE TABLE IF NOT EXISTS user_roles (
    id INTEGER PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL,
    role_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);

CREATE TABLE IF NOT EXISTS user_passkeys (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    passkey_name TEXT NOT NULL,
    passkey_id TEXT NOT NULL,
    passkey TEXT NOT NULL,
    counter INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_passkeys_user_id ON user_passkeys(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_passkeys_user_id_passkey_id ON user_passkeys(user_id, passkey_id);

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

CREATE TABLE IF NOT EXISTS address_delete_operations (
    address_id INTEGER NOT NULL, request_id TEXT NOT NULL, address TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('deleted','absent','changed')),
    batch_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(address_id,request_id)
);
