import { authorize } from '../auth';
import { body, HttpError, json } from '../http';
import {
  ASSISTANT_TOOLSET_VERSION,
  assistantDB,
  chatById,
  createChat,
  createRun,
  deleteChat,
  event,
  finishRun,
  runById,
  snapshot,
  type Chat,
  type Run,
} from './store';
import {
  capability,
  executeTool,
  fileDetails,
  instructions,
  tools,
  verifyCapability,
  workerSecret,
} from './tools';
import { indexStatus, startIndex } from './documents';

const controllers = new Map<string, AbortController>();
function workerUrl(route: string) {
  const target = process.env.ASSISTANT_WORKER_URL;
  if (!target) throw new HttpError(503, 'Deploy the Codex worker to connect your assistant.');
  const url = new URL(target);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new HttpError(503, 'The assistant worker address is invalid.');
  return new URL(route, url);
}
async function worker(route: string, data?: unknown, signal?: AbortSignal) {
  const response = await fetch(workerUrl(route), {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + workerSecret(), 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: signal || AbortSignal.timeout(50000),
    cache: 'no-store',
  });
  if (!response.ok) {
    let error = 'The assistant could not connect. Try again.';
    try {
      error = (await response.json()).error || error;
    } catch {}
    throw new HttpError(response.status >= 500 ? 503 : response.status, error);
  }
  return response;
}
function priorConversation(chat: Chat, before: number, resuming: boolean) {
  if (resuming) return '';
  const rows = assistantDB()
    .prepare(
      "SELECT role,text FROM assistant_messages WHERE chat_id=? AND created_at<? AND text<>'' ORDER BY created_at DESC,id DESC LIMIT 20",
    )
    .all(chat.id, before) as unknown as { role: string; text: string }[];
  if (!rows.length) return '';
  const transcript = rows
    .reverse()
    .map((row) => (row.role === 'user' ? 'User' : 'Assistant') + ': ' + row.text)
    .join('\n');
  const clipped = transcript.length > 2200 ? transcript.slice(-2200) : transcript;
  return (
    'Previous Pocket Drive conversation context (for continuity only). File claims must still be verified with the current tools, and prior statements about tool availability may be stale.\n' +
    clipped
  );
}
function missingPocketDriveTool(text: string) {
  return (
    /(?:file[- ]search|document[- ]reading|search_files|read_document|drive|tool).{0,120}(?:unavailable|disabled|not available|cannot access|can't access|couldn't access|could not access)/is.test(
      text,
    ) ||
    /(?:couldn't|could not|can't|cannot).{0,80}(?:open|read|search|access).{0,120}(?:file|document|drive|tool)/is.test(
      text,
    )
  );
}
async function reply(chat: Chat, run: Run, text: string, context: string) {
  const controller = new AbortController();
  controllers.set(run.id, controller);
  const timeout = setTimeout(() => controller.abort(), 8 * 60000);
  const resumableThread =
    chat.thread_id && chat.toolset_version === ASSISTANT_TOOLSET_VERSION ? chat.thread_id : null;
  let threadId = resumableThread;
  let attempt = 0;
  try {
    while (true) {
      let output = '';
      let saved = 0;
      let completed = false;
      let completionStatus = 'failed';
      let completionError: string | null = null;
      let sawToolActivity = false;
      if (attempt)
        assistantDB()
          .prepare('UPDATE assistant_messages SET text=? WHERE id=?')
          .run('', run.message_id);
      const history = priorConversation(chat, run.created_at, Boolean(threadId));
      const turnText = [
        history,
        text,
        context ? 'Current website context (metadata only): ' + context : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      function persist() {
        if (runById(run.id).status === 'running')
          assistantDB()
            .prepare('UPDATE assistant_messages SET text=? WHERE id=?')
            .run(output, run.message_id);
      }
      const response = await worker(
        '/turn',
        {
          runId: run.id,
          threadId,
          text: turnText,
          instructions:
            instructions +
            '\nFile-change permission for this message: ' +
            (run.organize
              ? 'enabled for explicitly requested changes.'
              : 'disabled; document access only.'),
          tools,
          capability: capability(run),
        },
        controller.signal,
      );
      if (!response.body) throw new Error('Codex did not start a reply.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 256 * 1024) throw new Error('Codex sent an oversized reply event.');
          let newline;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const value = JSON.parse(line);
            if (runById(run.id).status !== 'running') {
              await reader.cancel();
              return;
            }
            if (value.type === 'thread' && typeof value.id === 'string' && value.id.length < 200) {
              threadId = value.id;
              assistantDB()
                .prepare('UPDATE assistant_chats SET thread_id=?,toolset_version=? WHERE id=?')
                .run(value.id, ASSISTANT_TOOLSET_VERSION, chat.id);
            }
            if (value.type === 'delta' && typeof value.text === 'string') {
              output += value.text;
              if (output.length > 65536)
                throw new Error('The reply reached its length limit. Ask for a shorter response.');
              if (Date.now() - saved > 200) {
                persist();
                saved = Date.now();
              }
            }
            if (value.type === 'activity') {
              sawToolActivity = true;
              event(run.id, 'activity', { tool: String(value.tool).slice(0, 80) });
            }
            if (value.type === 'completed') {
              persist();
              completed = true;
              completionStatus = ['completed', 'interrupted', 'failed'].includes(value.status)
                ? value.status
                : 'failed';
              completionError = typeof value.error === 'string' ? value.error.slice(0, 500) : null;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!completed)
        throw new Error(
          'The connection closed before the reply finished. Send a new message to continue.',
        );

      const missingTools =
        completionStatus === 'completed' && !sawToolActivity && missingPocketDriveTool(output);
      if (missingTools) {
        assistantDB()
          .prepare('UPDATE assistant_chats SET thread_id=NULL,toolset_version=NULL WHERE id=?')
          .run(chat.id);
        if (threadId && attempt === 0) {
          threadId = null;
          attempt += 1;
          continue;
        }
      }
      finishRun(run, completionStatus, completionError);
      break;
    }
  } catch (error) {
    finishRun(
      run,
      'failed',
      controller.signal.aborted
        ? 'Reply timed out or was stopped.'
        : (error as Error).message.slice(0, 500),
    );
  } finally {
    clearTimeout(timeout);
    controllers.delete(run.id);
  }
}
export async function assistantApi(request: Request, segments: string[]) {
  const route = segments.slice(1);
  const method = request.method;
  if (route.join('/') === 'tools' && method === 'POST') {
    const run = verifyCapability(request);
    const data = await body(request, 128 * 1024);
    if (!data.arguments || typeof data.arguments !== 'object' || Array.isArray(data.arguments))
      throw new HttpError(400, 'Invalid tool arguments.');
    return json(await executeTool(run, data.tool, data.arguments as Record<string, unknown>));
  }
  authorize(request, 'read', true);
  assistantDB();
  if (route.join('/') === 'status' && method === 'GET') {
    if (!process.env.ASSISTANT_WORKER_URL)
      return json({
        enabled: false,
        connected: false,
        model: 'gpt-6.1-sol',
        effort: 'medium',
        index: indexStatus(),
      });
    startIndex();
    try {
      return json({
        enabled: true,
        ...(await (await worker('/status')).json()),
        index: indexStatus(),
      });
    } catch {
      return json({
        enabled: true,
        connected: false,
        offline: true,
        error: 'The Codex worker is unavailable. Check its deployment and connection settings.',
        index: indexStatus(),
      });
    }
  }
  if (['login', 'logout'].includes(route.join('/')) && method === 'POST')
    return json(await (await worker('/' + route[0], {})).json());
  if (route.join('/') === 'chats') {
    if (method === 'GET')
      return json({
        chats: assistantDB()
          .prepare(
            'SELECT id,title,created_at,updated_at FROM assistant_chats ORDER BY updated_at DESC LIMIT 200',
          )
          .all(),
      });
    if (method === 'POST') return json(createChat(), 201);
  }
  if (route[0] === 'chats' && route.length >= 2) {
    const chat = chatById(route[1]);
    if (route.length === 2 && method === 'DELETE') return json(deleteChat(chat));
    if (route.length === 2 && method === 'GET') {
      const raw = new URL(request.url).searchParams.get('before');
      const before = raw ? Number(raw) : undefined;
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
        throw new HttpError(400, 'Invalid history page.');
      const value = snapshot(chat, before);
      const current = new Map<string, ReturnType<typeof fileDetails> | null>();
      for (const entry of value.events) {
        if (!Array.isArray(entry.data.sources)) continue;
        entry.data.sources = entry.data.sources.map((source: ReturnType<typeof fileDetails>) => {
          if (!current.has(source.id)) {
            try {
              current.set(source.id, fileDetails(source.id));
            } catch {
              current.set(source.id, null);
            }
          }
          return current.get(source.id) || source;
        });
      }
      return json(value);
    }
    if (route.length === 3 && route[2] === 'messages' && method === 'POST') {
      const data = await body(request, 40000);
      if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 8000)
        throw new HttpError(400, 'Write a message using 1–8,000 characters.');
      if (data.organize !== undefined && typeof data.organize !== 'boolean')
        throw new HttpError(400, 'Invalid organization permission.');
      let context = '';
      if (data.file_id !== undefined) context = JSON.stringify(fileDetails(data.file_id));
      const status = await (await worker('/status')).json();
      if (!status.connected) throw new HttpError(409, 'Connect your personal Codex account first.');
      const run = createRun(chat, data.text.trim(), data.organize === true);
      void reply(chat, run, data.text.trim(), context);
      return json({ run }, 202);
    }
  }
  if (route[0] === 'runs' && route.length === 3 && route[2] === 'cancel' && method === 'POST') {
    const run = runById(route[1]);
    finishRun(run, 'interrupted', 'Reply stopped.');
    controllers.get(run.id)?.abort();
    await worker('/cancel', { runId: run.id }).catch(() => {});
    return json({ success: true });
  }
  throw new HttpError(404, 'Assistant endpoint not found.');
}
