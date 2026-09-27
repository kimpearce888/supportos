import type { Migration } from '../migrator.js';

/** Core Help Scout mirror schema: reference data, people, conversations, threads, attachments. */
export const migration001: Migration = {
  id: 1,
  name: 'core_helpscout_mirror',
  up: (db) => {
    db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE,
        plan TEXT,
        company_name TEXT,
        raw_json TEXT,
        raw_json_hash TEXT,
        last_seen_at TEXT,
        local_created_at TEXT NOT NULL DEFAULT (datetime('now')),
        local_updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE mailboxes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE NOT NULL,
        name TEXT NOT NULL,
        slug TEXT,
        email TEXT,
        remote_created_at TEXT,
        remote_updated_at TEXT,
        raw_json TEXT,
        raw_json_hash TEXT,
        last_seen_at TEXT,
        last_synced_at TEXT,
        deleted_at TEXT
      );

      CREATE TABLE folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE NOT NULL,
        mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT,
        user_id INTEGER,
        total_count INTEGER DEFAULT 0,
        active_count INTEGER DEFAULT 0,
        raw_json TEXT,
        last_synced_at TEXT,
        deleted_at TEXT
      );
      CREATE INDEX idx_folders_mailbox ON folders(mailbox_id);

      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE NOT NULL,
        first_name TEXT,
        last_name TEXT,
        email TEXT,
        role TEXT,
        type TEXT NOT NULL DEFAULT 'user',
        timezone TEXT,
        photo_url TEXT,
        initials TEXT,
        mention TEXT,
        job_title TEXT,
        phone TEXT,
        alternate_emails TEXT,
        remote_created_at TEXT,
        remote_updated_at TEXT,
        raw_json TEXT,
        raw_json_hash TEXT,
        last_seen_at TEXT,
        last_synced_at TEXT,
        deleted_at TEXT
      );
      CREATE INDEX idx_users_email ON users(email);

      CREATE TABLE system_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE NOT NULL,
        first_name TEXT,
        last_name TEXT,
        initials TEXT,
        timezone TEXT,
        role TEXT,
        remote_created_at TEXT,
        remote_updated_at TEXT,
        raw_json TEXT,
        last_synced_at TEXT,
        deleted_at TEXT
      );

      CREATE TABLE teams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE NOT NULL,
        name TEXT NOT NULL,
        raw_json TEXT,
        remote_created_at TEXT,
        remote_updated_at TEXT,
        last_synced_at TEXT,
        deleted_at TEXT
      );

      CREATE TABLE team_members (
        team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (team_id, user_id)
      );

      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE NOT NULL,
        name TEXT NOT NULL,
        slug TEXT,
        color TEXT,
        ticket_count INTEGER DEFAULT 0,
        remote_created_at TEXT,
        remote_updated_at TEXT,
        raw_json TEXT,
        last_seen_at TEXT,
        last_synced_at TEXT,
        deleted_at TEXT
      );
      CREATE INDEX idx_tags_name ON tags(name);

      CREATE TABLE inbox_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE NOT NULL,
        mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT,
        system_type TEXT,
        required INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        raw_json TEXT,
        last_synced_at TEXT,
        deleted_at TEXT
      );
      CREATE INDEX idx_inbox_fields_mailbox ON inbox_fields(mailbox_id);

      CREATE TABLE inbox_field_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE NOT NULL,
        field_id INTEGER NOT NULL REFERENCES inbox_fields(id) ON DELETE CASCADE,
        label TEXT,
        sort_order INTEGER DEFAULT 0
      );
      CREATE INDEX idx_field_options_field ON inbox_field_options(field_id);

      CREATE TABLE customer_property_definitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE NOT NULL,
        name TEXT NOT NULL,
        slug TEXT,
        type TEXT,
        sort_order INTEGER DEFAULT 0,
        raw_json TEXT,
        last_synced_at TEXT,
        deleted_at TEXT
      );

      CREATE TABLE organization_property_definitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE NOT NULL,
        name TEXT NOT NULL,
        slug TEXT,
        type TEXT,
        sort_order INTEGER DEFAULT 0,
        raw_json TEXT,
        last_synced_at TEXT,
        deleted_at TEXT
      );

      CREATE TABLE organizations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE NOT NULL,
        name TEXT NOT NULL,
        domains TEXT,
        raw_json TEXT,
        raw_json_hash TEXT,
        remote_created_at TEXT,
        remote_updated_at TEXT,
        last_seen_at TEXT,
        last_synced_at TEXT,
        local_created_at TEXT NOT NULL DEFAULT (datetime('now')),
        local_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT
      );
      CREATE INDEX idx_organizations_name ON organizations(name);

      CREATE TABLE organization_properties (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        definition_id INTEGER NOT NULL REFERENCES organization_property_definitions(id),
        value TEXT,
        UNIQUE (organization_id, definition_id)
      );

      CREATE TABLE customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE NOT NULL,
        first_name TEXT,
        last_name TEXT,
        photo_url TEXT,
        job_title TEXT,
        organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
        raw_json TEXT,
        raw_json_hash TEXT,
        remote_created_at TEXT,
        remote_updated_at TEXT,
        last_seen_at TEXT,
        last_synced_at TEXT,
        local_created_at TEXT NOT NULL DEFAULT (datetime('now')),
        local_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at TEXT
      );
      CREATE INDEX idx_customers_remote ON customers(remote_id);
      CREATE INDEX idx_customers_name ON customers(last_name, first_name);

      CREATE TABLE customer_emails (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        value TEXT NOT NULL,
        type TEXT,
        UNIQUE (customer_id, value)
      );
      CREATE INDEX idx_customer_emails_value ON customer_emails(value);
      CREATE INDEX idx_customer_emails_customer ON customer_emails(customer_id);

      CREATE TABLE customer_phones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        value TEXT,
        type TEXT
      );

      CREATE TABLE customer_addresses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        lines TEXT,
        city TEXT,
        state TEXT,
        postal_code TEXT,
        country TEXT,
        raw_json TEXT
      );

      CREATE TABLE customer_websites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        value TEXT
      );

      CREATE TABLE customer_social_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        value TEXT,
        type TEXT
      );

      CREATE TABLE customer_properties (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        definition_id INTEGER NOT NULL REFERENCES customer_property_definitions(id),
        value TEXT,
        UNIQUE (customer_id, definition_id)
      );

      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE NOT NULL,
        number INTEGER UNIQUE,
        subject TEXT,
        preview TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        state TEXT DEFAULT 'published',
        type TEXT,
        mailbox_local_id INTEGER REFERENCES mailboxes(id),
        folder_local_id INTEGER REFERENCES folders(id),
        customer_local_id INTEGER REFERENCES customers(id),
        assignee_local_id INTEGER REFERENCES users(id),
        assigned_team_local_id INTEGER REFERENCES teams(id),
        closed_by INTEGER,
        closed_at TEXT,
        snoozed_until TEXT,
        thread_count INTEGER DEFAULT 0,
        is_unread INTEGER DEFAULT 0,
        hs_url TEXT,
        merged_into_conversation_id INTEGER REFERENCES conversations(id),
        remote_created_at TEXT,
        remote_updated_at TEXT,
        local_created_at TEXT NOT NULL DEFAULT (datetime('now')),
        local_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT,
        last_synced_at TEXT,
        first_activity_at TEXT,
        last_activity_at TEXT,
        raw_json TEXT,
        raw_json_hash TEXT,
        deleted_at TEXT
      );
      CREATE INDEX idx_conversations_status ON conversations(status);
      CREATE INDEX idx_conversations_mailbox ON conversations(mailbox_local_id);
      CREATE INDEX idx_conversations_customer ON conversations(customer_local_id);
      CREATE INDEX idx_conversations_assignee ON conversations(assignee_local_id);
      CREATE INDEX idx_conversations_number ON conversations(number);
      CREATE INDEX idx_conversations_remote_updated ON conversations(remote_updated_at);
      CREATE INDEX idx_conversations_last_activity ON conversations(last_activity_at DESC);

      CREATE TABLE conversation_tags (
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        tag_local_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (conversation_id, tag_local_id)
      );
      CREATE INDEX idx_conversation_tags_tag ON conversation_tags(tag_local_id);

      CREATE TABLE conversation_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        field_local_id INTEGER NOT NULL REFERENCES inbox_fields(id),
        value TEXT,
        text_value TEXT,
        UNIQUE (conversation_id, field_local_id)
      );
      CREATE INDEX idx_conversation_fields_conv ON conversation_fields(conversation_id);

      CREATE TABLE threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        type TEXT,
        state TEXT DEFAULT 'published',
        body_text TEXT,
        body_html TEXT,
        from_name TEXT,
        from_email TEXT,
        from_type TEXT,
        created_by_user_id INTEGER REFERENCES users(id),
        created_by_customer_id INTEGER REFERENCES customers(id),
        created_by_system_user_id INTEGER REFERENCES system_users(id),
        assigned_to_type TEXT,
        assigned_to_id INTEGER,
        saved_reply_local_id INTEGER REFERENCES saved_replies(id),
        action_type TEXT,
        action_text TEXT,
        to_list TEXT,
        cc_list TEXT,
        bcc_list TEXT,
        scheduled_for TEXT,
        remote_created_at TEXT,
        remote_updated_at TEXT,
        local_created_at TEXT NOT NULL DEFAULT (datetime('now')),
        local_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_synced_at TEXT,
        raw_json TEXT,
        raw_json_hash TEXT,
        deleted_at TEXT,
        fts_indexed INTEGER DEFAULT 0,
        embedding_state TEXT DEFAULT 'not_indexed'
      );
      CREATE INDEX idx_threads_conversation ON threads(conversation_id);
      CREATE INDEX idx_threads_remote_created ON threads(remote_created_at);
      CREATE INDEX idx_threads_type ON threads(type);
      CREATE INDEX idx_threads_embedding ON threads(embedding_state);

      CREATE TABLE thread_participants (
        thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        person_type TEXT NOT NULL,
        person_local_id INTEGER,
        name TEXT,
        email TEXT,
        role TEXT,
        PRIMARY KEY (thread_id, person_type, person_local_id, role)
      );

      CREATE TABLE thread_recipients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('to','cc','bcc'))
      );
      CREATE INDEX idx_thread_recipients_thread ON thread_recipients(thread_id);

      CREATE TABLE attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE,
        thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        filename TEXT,
        mime_type TEXT,
        size INTEGER,
        local_path TEXT,
        hash TEXT,
        downloaded_at TEXT,
        state TEXT DEFAULT 'metadata',
        raw_json TEXT
      );
      CREATE INDEX idx_attachments_thread ON attachments(thread_id);
      CREATE INDEX idx_attachments_conversation ON attachments(conversation_id);

      CREATE TABLE ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
        thread_local_id INTEGER REFERENCES threads(id),
        rating TEXT,
        comments TEXT,
        customer_local_id INTEGER REFERENCES customers(id),
        user_local_id INTEGER REFERENCES users(id),
        remote_created_at TEXT,
        raw_json TEXT,
        last_synced_at TEXT
      );
      CREATE INDEX idx_ratings_conversation ON ratings(conversation_id);

      CREATE TABLE saved_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE,
        mailbox_local_id INTEGER REFERENCES mailboxes(id),
        name TEXT NOT NULL,
        preview TEXT,
        text TEXT,
        chat_text TEXT,
        raw_json TEXT,
        remote_updated_at TEXT,
        last_synced_at TEXT,
        deleted_at TEXT
      );
      CREATE INDEX idx_saved_replies_name ON saved_replies(name);

      CREATE TABLE workflows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE,
        mailbox_local_id INTEGER REFERENCES mailboxes(id),
        name TEXT NOT NULL,
        type TEXT,
        status TEXT,
        sort_order INTEGER,
        raw_json TEXT,
        remote_updated_at TEXT,
        last_synced_at TEXT,
        deleted_at TEXT
      );

      CREATE TABLE routing_configurations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mailbox_local_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        raw_json TEXT,
        last_synced_at TEXT
      );

      CREATE TABLE user_statuses (
        user_local_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        email_status TEXT,
        email_updated_at TEXT,
        chat_status TEXT,
        mailbox_statuses TEXT,
        raw_json TEXT,
        last_synced_at TEXT
      );

      CREATE TABLE webhook_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        remote_id INTEGER UNIQUE,
        url TEXT,
        events TEXT,
        status TEXT,
        raw_json TEXT,
        last_synced_at TEXT
      );
    `);
  }
};
