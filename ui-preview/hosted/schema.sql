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
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_chat_request
    ON jobs (chat_id) WHERE chat_id IS NOT NULL AND state IN ('queued', 'running');
