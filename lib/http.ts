export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
export async function body(req: Request, limit = 8192): Promise<Record<string, unknown>> {
  if (!req.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Send JSON with Content-Type: application/json.');
  if (!req.body) throw new HttpError(400, 'Request body is required.');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > limit) { await reader.cancel(); throw new HttpError(413, 'Request is too large.'); }
      chunks.push(part.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Request must contain a valid JSON object.');
  } finally { reader.releaseLock(); }
}
