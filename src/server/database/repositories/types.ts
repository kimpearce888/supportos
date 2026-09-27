/** Repository-layer row shapes not shared with the client. */

export interface MailboxRow {
  id: number;
  remote_id: number;
  name: string;
  slug: string | null;
  email: string | null;
  remote_created_at: string | null;
  remote_updated_at: string | null;
  raw_json: string | null;
  last_synced_at: string | null;
  deleted_at: string | null;
}

export interface FolderInfo {
  id: number;
  remote_id: number;
  mailbox_id: number;
  name: string;
  type: string | null;
  total_count: number;
  active_count: number;
}

export interface UserStatusInfo {
  user_id: number;
  email_status: string | null;
  chat_status: string | null;
  mailbox_statuses: Record<string, string>;
}

export interface WebhookConfigInfo {
  id: number;
  remote_id: number;
  url: string;
  events: string[];
  status: string | null;
}

export interface ConversationRow {
  id: number;
  remote_id: number;
  number: number;
  subject: string | null;
  preview: string | null;
  status: string;
  state: string | null;
  type: string | null;
  source_type: string | null;
  source_via: string | null;
  mailbox_local_id: number | null;
  folder_local_id: number | null;
  customer_local_id: number | null;
  assignee_local_id: number | null;
  assigned_team_local_id: number | null;
  closed_at: string | null;
  snoozed_until: string | null;
  thread_count: number;
  is_unread: number;
  hs_url: string | null;
  merged_into_conversation_id: number | null;
  remote_created_at: string | null;
  remote_updated_at: string | null;
  local_created_at: string;
  local_updated_at: string;
  last_seen_at: string | null;
  last_synced_at: string | null;
  first_activity_at: string | null;
  last_activity_at: string | null;
  raw_json: string | null;
  deleted_at: string | null;
}

export interface ThreadRow {
  id: number;
  remote_id: number | null;
  conversation_id: number;
  type: string | null;
  state: string | null;
  body_text: string | null;
  body_html: string | null;
  from_name: string | null;
  from_email: string | null;
  from_type: string | null;
  created_by_user_id: number | null;
  created_by_customer_id: number | null;
  scheduled_for: string | null;
  remote_created_at: string | null;
  saved_reply_local_id: number | null;
  to_list: string | null;
  cc_list: string | null;
  bcc_list: string | null;
  fts_indexed: number;
  embedding_state: string | null;
  deleted_at: string | null;
}

export interface CustomerRow {
  id: number;
  remote_id: number;
  first_name: string | null;
  last_name: string | null;
  photo_url: string | null;
  job_title: string | null;
  organization_id: number | null;
  raw_json: string | null;
  remote_created_at: string | null;
  remote_updated_at: string | null;
  deleted_at: string | null;
}

export interface AttachmentRow {
  id: number;
  remote_id: number | null;
  thread_id: number;
  conversation_id: number;
  filename: string | null;
  mime_type: string | null;
  size: number | null;
  local_path: string | null;
  hash: string | null;
  downloaded_at: string | null;
  state: string;
}
