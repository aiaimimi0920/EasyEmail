CREATE TABLE normal_message_labels (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES normal_inbox_messages(id),
  label_id TEXT NOT NULL,
  PRIMARY KEY(user_id,message_id,label_id),
  FOREIGN KEY(user_id,label_id) REFERENCES labels(user_id,id)
);
CREATE INDEX normal_message_labels_filter ON normal_message_labels(user_id,label_id,message_id);
CREATE TABLE normal_message_folders (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES normal_inbox_messages(id),
  folder_id TEXT NOT NULL,
  PRIMARY KEY(user_id,message_id),
  FOREIGN KEY(user_id,folder_id) REFERENCES folders(user_id,id)
);
CREATE INDEX normal_message_folders_filter ON normal_message_folders(user_id,folder_id,message_id);
