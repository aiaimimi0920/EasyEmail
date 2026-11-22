CREATE TABLE IF NOT EXISTS address_delete_operations (
    address_id INTEGER NOT NULL, request_id TEXT NOT NULL, address TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('deleted','absent','changed')),
    batch_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(address_id,request_id)
);
