CREATE TABLE IF NOT EXISTS model_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL,
    seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    state TEXT NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_owner ON approvals (owner, created DESC);

CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    title TEXT NOT NULL,
    messages TEXT NOT NULL DEFAULT '[]',
    updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_owner ON chats (owner, updated DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    message TEXT NOT NULL,
    PRIMARY KEY (chat_id, position)
);

CREATE TABLE IF NOT EXISTS chat_memory (
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    settings TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS account_profiles (
    owner TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    avatar TEXT,
    appearance TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    approval_id TEXT NOT NULL REFERENCES approvals(id),
    chat_id TEXT REFERENCES chats(id),
    kind TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'queued',
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL,
    lease TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs (state, created);
CREATE INDEX IF NOT EXISTS jobs_chat_history ON jobs (chat_id, created DESC);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_chat_request
    ON jobs (chat_id) WHERE chat_id IS NOT NULL AND state IN ('queued', 'running');
