ALTER TABLE normal_remote_flag_operations ADD COLUMN server_folder_id TEXT;
ALTER TABLE normal_remote_flag_operations ADD COLUMN server_wire_name TEXT;
ALTER TABLE normal_remote_flag_operations ADD COLUMN catalog_source TEXT CHECK (
  (server_folder_id IS NULL AND server_wire_name IS NULL AND catalog_source IS NULL)
  OR (server_folder_id IS NOT NULL AND server_wire_name IS NOT NULL AND catalog_source IS NOT NULL
    AND length(server_folder_id)=64 AND server_folder_id NOT GLOB '*[^0-9a-f]*'
    AND length(catalog_source)=64 AND catalog_source NOT GLOB '*[^0-9a-f]*'
    AND length(server_wire_name) BETWEEN 1 AND 1024 AND upper(server_wire_name)<>'INBOX')
);
