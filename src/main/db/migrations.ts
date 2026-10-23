export interface Migration {
  version: number
  name: string
  sql: string
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
CREATE TABLE website_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#6366f1',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE websites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  icon TEXT,
  description TEXT,
  group_id INTEGER REFERENCES website_groups(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#64748b',
  created_at TEXT NOT NULL
);

CREATE TABLE website_tags (
  website_id INTEGER NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (website_id, tag_id)
);

CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE COLLATE NOCASE,
  note TEXT,
  is_missing INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE folder_tags (
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (folder_id, tag_id)
);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  file_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('file', 'note')),
  folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
  file_name TEXT NOT NULL,
  extension TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  last_modified_at TEXT NOT NULL,
  parser_version INTEGER NOT NULL DEFAULT 1,
  indexing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (indexing_status IN ('pending', 'processing', 'indexed', 'failed', 'cancelled')),
  indexed_at TEXT,
  active_generation TEXT,
  index_model_id TEXT,
  index_config_version TEXT,
  error_message TEXT,
  content_text TEXT,
  last_scanned_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_documents_folder ON documents(folder_id);
CREATE INDEX idx_documents_kind ON documents(kind);
CREATE INDEX idx_documents_hash ON documents(file_hash);

CREATE TABLE document_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  generation TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  heading_path TEXT,
  start_offset INTEGER NOT NULL DEFAULT 0,
  end_offset INTEGER NOT NULL DEFAULT 0,
  page_number INTEGER,
  token_count INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,
  embedding_model_id TEXT NOT NULL,
  embedding_dim INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(document_id, generation, chunk_index)
);

CREATE INDEX idx_chunks_doc_generation ON document_chunks(document_id, generation);
CREATE INDEX idx_chunks_model ON document_chunks(embedding_model_id);

CREATE TABLE chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'general' CHECK (mode IN ('general', 'rag')),
  learning_mode TEXT NOT NULL DEFAULT 'free',
  scope_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'complete'
    CHECK (status IN ('complete', 'streaming', 'stopped', 'error')),
  citations_json TEXT NOT NULL DEFAULT '[]',
  retrieval_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_messages_chat ON messages(chat_id, id);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  due_date TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE index_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('scan', 'index')),
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  total INTEGER NOT NULL DEFAULT 0,
  processed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE search_fts USING fts5(
  entity_type,
  entity_id UNINDEXED,
  title,
  body,
  body_raw UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE INDEX idx_notes_updated ON notes(updated_at DESC);
CREATE INDEX idx_chats_updated ON chats(updated_at DESC);
CREATE INDEX idx_jobs_created ON index_jobs(created_at DESC);
`
  }
]
