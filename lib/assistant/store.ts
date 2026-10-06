import { randomUUID } from 'node:crypto';
import { db, transaction } from '../db';
import { HttpError } from '../http';
import { validId } from '../storage';

let initialized = false;
export function assistantDB() {
  const database = db();
  if (!initialized) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS assistant_chats(id TEXT PRIMARY KEY,title TEXT NOT NULL,thread_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_messages(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS assistant_messages_chat ON assistant_messages(chat_id,created_at);
      CREATE TABLE IF NOT EXISTS assistant_runs(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,message_id TEXT NOT NULL,status TEXT NOT NULL,organize INTEGER NOT NULL,created_at INTEGER NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS assistant_events(id INTEGER PRIMARY KEY,run_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assistant_documents(file_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,sections TEXT NOT NULL,limited INTEGER NOT NULL,error TEXT);
      CREATE VIRTUAL TABLE IF NOT EXISTS assistant_search USING fts5(file_id UNINDEXED,section UNINDEXED,text,tokenize='unicode61');
      UPDATE assistant_runs SET status='interrupted',error='The server restarted. Send a new message to continue.' WHERE status='running';
    `);
    initialized = true;
  }
  return database;
}
export interface Chat { id: string; title: string; thread_id: string | null; created_at: number; updated_at: number }
export interface Run { id: string; chat_id: string; message_id: string; status: string; organize: number; created_at: number; error: string | null }
export function chatById(id: string) {
  if (!validId(id)) throw new HttpError(404, 'Conversation not found.');
  const chat = assistantDB().prepare('SELECT * FROM assistant_chats WHERE id=?').get(id) as unknown as Chat | undefined;
  if (!chat) throw new HttpError(404, 'Conversation not found.');
  return chat;
}
export function runById(id: string) {
  if (!validId(id)) throw new HttpError(404, 'Reply not found.');
  const run = assistantDB().prepare('SELECT * FROM assistant_runs WHERE id=?').get(id) as unknown as Run | undefined;
  if (!run) throw new HttpError(404, 'Reply not found.');
  return run;
}
export function event(run: string, kind: string, data: unknown) {
  assistantDB().prepare('INSERT INTO assistant_events(run_id,kind,data) VALUES(?,?,?)').run(run, kind, JSON.stringify(data));
}
export function createChat() {
  const database = assistantDB();
  if (Number(database.prepare('SELECT COUNT(*) AS n FROM assistant_chats').get()!.n) >= 200) throw new HttpError(409, 'The conversation limit is 200.');
  const id = randomUUID(); const now = Date.now();
  database.prepare('INSERT INTO assistant_chats VALUES(?,?,NULL,?,?)').run(id, 'New conversation', now, now);
  return chatById(id);
}
export function createRun(chat: Chat, text: string, organize: boolean) {
  const database = assistantDB();
  return transaction(() => {
    if (database.prepare("SELECT 1 FROM assistant_runs WHERE status='running'").get()) throw new HttpError(409, 'Wait for the current reply or stop it first.');
    if (Number(database.prepare('SELECT COUNT(*) AS n FROM assistant_messages WHERE chat_id=?').get(chat.id)!.n) >= 400) throw new HttpError(409, 'Start a new conversation to continue.');
    const id = randomUUID(); const message = randomUUID(); const now = Date.now();
    database.prepare('INSERT INTO assistant_messages VALUES(?,?,?,?,?)').run(randomUUID(), chat.id, 'user', text, now);
    database.prepare('INSERT INTO assistant_messages VALUES(?,?,?,?,?)').run(message, chat.id, 'assistant', '', now + 1);
    database.prepare('INSERT INTO assistant_runs VALUES(?,?,?,?,?,?,NULL)').run(id, chat.id, message, 'running', Number(organize), now);
    database.prepare('UPDATE assistant_chats SET title=?,updated_at=? WHERE id=?').run(chat.title === 'New conversation' ? text.replace(/\s+/g, ' ').slice(0, 70) : chat.title, now, chat.id);
    return runById(id);
  });
}
export function deleteChat(chat: Chat) {
  const database = assistantDB();
  return transaction(() => {
    if (database.prepare("SELECT 1 FROM assistant_runs WHERE chat_id=? AND status='running' LIMIT 1").get(chat.id)) throw new HttpError(409, 'Stop the active reply before deleting this conversation.');
    database.prepare('DELETE FROM assistant_events WHERE run_id IN (SELECT id FROM assistant_runs WHERE chat_id=?)').run(chat.id);
    database.prepare('DELETE FROM assistant_runs WHERE chat_id=?').run(chat.id);
    database.prepare('DELETE FROM assistant_messages WHERE chat_id=?').run(chat.id);
    database.prepare('DELETE FROM assistant_chats WHERE id=?').run(chat.id);
    return { success: true };
  });
}
export function finishRun(run: Run, status: string, error: string | null = null) {
  assistantDB().prepare("UPDATE assistant_runs SET status=?,error=? WHERE id=? AND status='running'").run(status, error, run.id);
}
export function snapshot(chat: Chat, before?: number) {
  const database = assistantDB();
  const messages = database.prepare('SELECT * FROM (SELECT * FROM assistant_messages WHERE chat_id=? AND created_at<? ORDER BY created_at DESC,id DESC LIMIT 50) ORDER BY created_at,id').all(chat.id, before || Number.MAX_SAFE_INTEGER);
  const first = messages[0] ? Number(messages[0].created_at) : 0;
  const last = messages.at(-1) ? Number(messages.at(-1)!.created_at) : 0;
  const runs = database.prepare('SELECT r.* FROM assistant_runs r JOIN assistant_messages m ON m.id=r.message_id WHERE r.chat_id=? AND m.created_at>=? AND m.created_at<=? ORDER BY r.created_at DESC').all(chat.id, first, last);
  const events = database.prepare("SELECT e.* FROM assistant_events e JOIN assistant_runs r ON r.id=e.run_id JOIN assistant_messages m ON m.id=r.message_id WHERE r.chat_id=? AND m.created_at>=? AND m.created_at<=? AND e.kind IN ('tool','activity') ORDER BY e.id").all(chat.id, first, last).map(e => ({ ...e, data: JSON.parse(String(e.data)) }));
  const hasOlder = !!database.prepare('SELECT 1 FROM assistant_messages WHERE chat_id=? AND created_at<? LIMIT 1').get(chat.id, first);
  return { chat, messages, runs, events, hasOlder, before: first };
}
