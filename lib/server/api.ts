import { randomBytes, randomUUID } from 'node:crypto';
import { listApiKeys } from './keys';
import { uploaderDownload } from './uploader-download';
import {
  authorize,
  checkOrigin,
  COOKIE,
  hashToken,
  login,
  sessionCookie,
  type Scope,
} from './auth';
import { config } from './config';
import { db, fileById, transaction } from './db';
import { body, HttpError, json } from './http';
import { cleanup, deleteFile, download, storageInfo, upload, validId } from './storage';
import {
  childFolders,
  createFolder,
  folderDetails,
  markFolderForDeletion,
  parentId,
  trail,
} from './folders';
import { folderTree, markItemsForDeletion, moveItems, renameItem } from './items';
import { downloadFolder, downloadItems } from './folder-download';
import { beginUpload, cancelUpload, finishUpload, uploadChunk, uploadStatus } from './resumable';
import { archiveEntries, previewContent, previewInfo, previewText } from './preview';
import { listFiles } from './listing';
import { preparedStatus, preparedContent } from './preview-cache';

export async function dispatch(req: Request, segments: string[]): Promise<Response> {
  try {
    const route = segments.join('/');
    const method = req.method;
    if (route === 'health' && method === 'GET') {
      config();
      db().prepare('SELECT 1').get();
      return json({ status: 'ok' });
    }
    if (segments[0] === 'assistant')
      return await (await import('./assistant/api')).assistantApi(req, segments);
    if (route === 'auth/login' && method === 'POST') {
      checkOrigin(req);
      const data = await body(req);
      const token = await login(data.username, data.password);
      const response = json({ success: true });
      response.headers.set('Set-Cookie', sessionCookie(token));
      return response;
    }
    if (route === 'auth/logout' && method === 'POST') {
      checkOrigin(req);
      const token = req.headers
        .get('cookie')
        ?.split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(`${COOKIE}=`))
        ?.slice(COOKIE.length + 1);
      if (token && token.length < 100)
        db().prepare('DELETE FROM sessions WHERE hash = ?').run(hashToken(token));
      const response = json({ success: true });
      response.headers.set('Set-Cookie', sessionCookie('', true));
      return response;
    }
    if (route === 'storage' && method === 'GET') {
      authorize(req);
      return json(await storageInfo());
    }
    if (route === 'uploads' && method === 'POST') {
      authorize(req, 'upload');
      return json(await beginUpload(await body(req, 16384), req.signal), 201);
    }
    if (segments[0] === 'uploads' && validId(segments[1] || '')) {
      authorize(req, 'upload');
      const id = segments[1];
      if (segments.length === 2 && method === 'GET') return json(uploadStatus(id));
      if (segments.length === 2 && method === 'PATCH') return json(await uploadChunk(req, id));
      if (segments.length === 2 && method === 'DELETE') return json(await cancelUpload(id));
      if (segments.length === 3 && segments[2] === 'complete' && method === 'POST')
        return json(await finishUpload(req, id));
    }
    if (route === 'folders/tree' && method === 'GET') {
      authorize(req);
      return json({ folders: folderTree() });
    }
    if (route === 'items/download' && ['GET', 'HEAD', 'POST'].includes(method)) {
      authorize(req);
      if (method === 'POST') {
        const data = await body(req);
        return await downloadItems(req, data.items);
      }
      const value = new URL(req.url).searchParams.get('items') || '';
      if (value.length > 4500) throw new HttpError(400, 'Select between 1 and 100 items.');
      const items = value.split(',').map((part) => {
        const [type, id, extra] = part.split(':');
        return { type: extra === undefined ? type : '', id };
      });
      return await downloadItems(req, items);
    }
    if (route === 'items/move' && method === 'POST') {
      authorize(req, 'upload');
      const data = await body(req);
      return json(moveItems(data.items, data.destination_id));
    }
    if (route === 'items/delete' && method === 'POST') {
      authorize(req, 'delete');
      const data = await body(req);
      const deleted = markItemsForDeletion(data.items);
      await cleanup();
      return json({ success: true, deleted });
    }
    if (route === 'files') {
      if (method === 'POST') {
        authorize(req, 'upload');
        return json(await upload(req), 201);
      }
      if (method === 'GET') {
        authorize(req);
        return json(listFiles(new URL(req.url).searchParams));
      }
    }
    if (route === 'folders') {
      if (method === 'GET') {
        authorize(req);
        const parent = parentId(new URL(req.url).searchParams.get('parent_id'));
        trail(parent);
        return json({ folders: childFolders(parent) });
      }
      if (method === 'POST') {
        authorize(req, 'upload');
        const data = await body(req);
        return json(createFolder(data.name, parentId(data.parent_id)), 201);
      }
    }
    if (
      segments[0] === 'folders' &&
      segments.length === 3 &&
      validId(segments[1]) &&
      segments[2] === 'download' &&
      ['GET', 'HEAD'].includes(method)
    ) {
      authorize(req);
      return await downloadFolder(req, segments[1]);
    }
    if (segments[0] === 'folders' && segments.length === 2 && validId(segments[1])) {
      if (method === 'PATCH') {
        authorize(req, 'upload');
        const data = await body(req);
        return json(renameItem({ type: 'folder', id: segments[1] }, data.name));
      }
      if (method === 'GET') {
        authorize(req);
        return json(folderDetails(segments[1]));
      }
      if (method === 'DELETE') {
        authorize(req, 'delete');
        markFolderForDeletion(segments[1]);
        await cleanup();
        return json({ success: true });
      }
    }
    if (segments[0] === 'files' && validId(segments[1] || '')) {
      const id = segments[1];
      if (
        segments.length === 4 &&
        segments[2] === 'preview' &&
        segments[3] === 'prepare' &&
        ['GET', 'POST'].includes(method)
      ) {
        authorize(req);
        const file = fileById(id);
        if (!file) throw new HttpError(404, 'File not found.');
        const status = await preparedStatus(
          file,
          new URL(req.url).searchParams.get('variant') || 'document',
          method === 'POST',
        );
        return json(status, status.status === 'running' ? 202 : 200);
      }
      if (
        segments[2] === 'preview' &&
        ['GET', 'HEAD'].includes(method) &&
        segments.length >= 3 &&
        segments.length <= 4
      ) {
        authorize(req);
        const file = fileById(id);
        if (!file) throw new HttpError(404, 'File not found.');
        if (segments.length === 3) return previewInfo(file);
        if (segments[3] === 'content') return await previewContent(req, file);
        if (segments[3] === 'prepared') return await preparedContent(req, file);
        if (segments[3] === 'text') return await previewText(file);
        if (segments[3] === 'archive' && file.name.toLowerCase().endsWith('.zip'))
          return json(await archiveEntries(req, file));
        throw new HttpError(415, 'This format cannot use that preview viewer.');
      }
      if (segments.length === 2 && method === 'PATCH') {
        authorize(req, 'upload');
        const data = await body(req);
        return json(renameItem({ type: 'file', id }, data.name));
      }
      if (segments.length === 3 && segments[2] === 'download' && ['GET', 'HEAD'].includes(method)) {
        authorize(req);
        const file = fileById(id);
        if (!file) throw new HttpError(404, 'File not found.');
        return await download(req, file);
      }
      if (segments.length === 2 && method === 'GET') {
        authorize(req);
        const file = fileById(id);
        if (!file) throw new HttpError(404, 'File not found.');
        const { deleting: _, ...metadata } = file;
        return json(metadata);
      }
      if (segments.length === 2 && method === 'DELETE') {
        authorize(req, 'delete');
        if (!fileById(id)) throw new HttpError(404, 'File not found.');
        await deleteFile(id);
        return json({ success: true });
      }
    }
    if (route === 'keys/uploader' && method === 'GET') {
      authorize(req, 'read', true);
      const query = new URL(req.url).searchParams;
      return await uploaderDownload(query.get('platform'), query.get('variant'));
    }
    if (route === 'keys') {
      authorize(req, 'read', true);
      if (method === 'GET') return json({ keys: listApiKeys() });
      if (method === 'POST') {
        const data = await body(req);
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!name || name.length > 60 || /[\x00-\x1f]/.test(name))
          throw new HttpError(400, 'Name your key using 1–60 characters.');
        const scopes = Array.isArray(data.scopes) ? [...new Set(data.scopes)] : ['read', 'upload'];
        if (
          !scopes.length ||
          scopes.some((s) => !['read', 'upload', 'delete'].includes(s as Scope))
        )
          throw new HttpError(400, 'Choose valid permissions.');
        const id = randomUUID();
        const token = 'pd_' + randomBytes(32).toString('hex');
        const createdAt = new Date().toISOString();
        transaction(() => {
          if ((db().prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n >= 50)
            throw new HttpError(400, 'Revoke an old key before creating more (maximum 50).');
          db()
            .prepare(
              'INSERT INTO api_keys(id, name, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)',
            )
            .run(id, name, hashToken(token), JSON.stringify(scopes), createdAt);
        });
        return json({ id, name, token, scopes, created_at: createdAt }, 201);
      }
    }
    if (segments[0] === 'keys' && segments.length === 2 && method === 'DELETE') {
      authorize(req, 'read', true);
      if (!validId(segments[1])) throw new HttpError(404, 'API key not found.');
      if (!db().prepare('DELETE FROM api_keys WHERE id = ?').run(segments[1]).changes)
        throw new HttpError(404, 'API key not found.');
      return json({ success: true });
    }
    throw new HttpError(404, 'Endpoint not found.');
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error('API request failed:', error instanceof Error ? error.message : 'Unknown error');
    return json(
      { error: 'The server could not complete this request. Check the server logs.' },
      500,
    );
  }
}
