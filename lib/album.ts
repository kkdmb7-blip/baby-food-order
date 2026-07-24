// ────────────────────────────────────────────────────────────────
// E. 이유식 성장앨범 — 기기 저장(IndexedDB) 전용.
// 사진은 손님 휴대폰에만 저장되고 서버로 절대 업로드되지 않음 (프라이버시).
// ────────────────────────────────────────────────────────────────

export type Photo = { id: string; date: string; note: string; blob: Blob };
export type PhotoMeta = { id: string; date: string; note: string; url: string };

const DB_NAME = 'bfo_album';
const STORE = 'photos';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 이미지 축소 (최대 1200px, JPEG 0.8) — 저장 용량 절약
export async function downscale(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // 실패 시 원본
  const max = 1200;
  let { width, height } = bitmap;
  if (width > max || height > max) {
    const r = Math.min(max / width, max / height);
    width = Math.round(width * r); height = Math.round(height * r);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return await new Promise<Blob>(res => canvas.toBlob(b => res(b || file), 'image/jpeg', 0.8));
}

export async function addPhoto(file: File, note: string): Promise<void> {
  const blob = await downscale(file);
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      date: new Date().toISOString().slice(0, 10),
      note: note.slice(0, 100), blob,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function listPhotos(): Promise<PhotoMeta[]> {
  const db = await openDB();
  const items: Photo[] = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as Photo[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return items
    .sort((a, b) => (a.date < b.date ? 1 : -1) || (a.id < b.id ? 1 : -1))
    .map(p => ({ id: p.id, date: p.date, note: p.note, url: URL.createObjectURL(p.blob) }));
}

export async function deletePhoto(id: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
