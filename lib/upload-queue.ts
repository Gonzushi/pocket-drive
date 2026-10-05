export interface QueueItem { id: string; name: string; relativePath: string; size: number; mime: string; offset: number; state: 'waiting' | 'uploading' | 'finishing' | 'done' | 'error'; attempted?: boolean; message?: string }
export interface UploadJob { id: string; destination: string; items: QueueItem[]; paused: boolean; cancelled: boolean; collapsed: boolean; message?: string }
let connection: Promise<IDBDatabase> | undefined;
function database() {
  if (!connection) connection = new Promise((resolve,reject) => {
    const request = indexedDB.open('pocket-drive-uploads',1);
    request.onupgradeneeded = () => { request.result.createObjectStore('queue'); request.result.createObjectStore('sources'); };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); connection = undefined; }; resolve(request.result); };
    request.onerror = () => { connection = undefined; reject(request.error); };
    request.onblocked = () => reject(new Error('Close other Pocket Drive tabs and try again.'));
  });
  return connection;
}
export async function readQueue(): Promise<UploadJob | null> {
  const db = await database();
  return new Promise((resolve,reject) => { const request = db.transaction('queue').objectStore('queue').get('active'); request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error); });
}
export async function sourceFile(id: string): Promise<Blob | undefined> {
  const db = await database();
  return new Promise((resolve,reject) => { const request = db.transaction('sources').objectStore('sources').get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
export async function saveQueue(job: UploadJob, files: File[], progress: (count: number) => void) {
  const db = await database();
  return new Promise<void>((resolve,reject) => {
    const tx = db.transaction(['queue','sources'],'readwrite',{durability:'strict'});
    let failure: Error | undefined;
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(failure || tx.error || new Error('Could not save the upload queue.')); tx.onerror = () => {};
    const current = tx.objectStore('queue').get('active');
    current.onsuccess = () => {
      const existing = current.result as UploadJob | undefined;
      if (existing && existing.items.some(item => item.state !== 'done')) { failure = new Error('Finish or cancel your current uploads before adding another batch.'); tx.abort(); return; }
      tx.objectStore('sources').clear(); tx.objectStore('queue').put(job,'active');
      let count = 0;
      files.forEach((file,index) => { const request = tx.objectStore('sources').put(file,job.items[index].id); request.onsuccess = () => progress(++count); });
    };
  });
}
export async function changeQueue(id: string, change: (job: UploadJob) => void, removeSource?: string): Promise<UploadJob | null> {
  const db = await database();
  return new Promise((resolve,reject) => {
    const tx = db.transaction(['queue','sources'],'readwrite',{durability:'strict'}); let result: UploadJob | null = null;
    tx.oncomplete = () => resolve(result); tx.onabort = () => reject(tx.error || new Error('Could not save upload progress.')); tx.onerror = () => {};
    const request = tx.objectStore('queue').get('active');
    request.onsuccess = () => { if (request.result?.id !== id) return; result = request.result; change(result!); if (removeSource) tx.objectStore('sources').delete(removeSource); tx.objectStore('queue').put(result,'active'); };
  });
}
export async function clearQueue(id: string) {
  const db = await database();
  return new Promise<void>((resolve,reject) => {
    const tx = db.transaction(['queue','sources'],'readwrite'); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => {};
    const request = tx.objectStore('queue').get('active'); request.onsuccess = () => { if (request.result?.id === id) { tx.objectStore('queue').delete('active'); tx.objectStore('sources').clear(); } };
  });
}
