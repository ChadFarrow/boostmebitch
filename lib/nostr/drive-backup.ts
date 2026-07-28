'use client';

// The user's encrypted key blob, stored in their own Google Drive appdata
// folder. Ported from Wisp's auth/DriveBackupService.kt.
//
// appDataFolder is a per-app hidden space: invisible in the normal Drive UI,
// unreadable by other apps, and it costs the user no visible storage. Combined
// with an opaque filename and no identifying metadata, Google holds a blob it
// cannot link to a Nostr identity — the npub exists only inside the ciphertext.
//
// This talks to Google's REST API directly from the browser with a bearer
// token; there is no server component and nothing about this ever reaches our
// own backend.

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

/** Thrown on a 401 so the caller can re-request a token instead of treating an
 *  expired credential as "no backups exist" — which would walk a returning
 *  user into the create-new-account flow and orphan their real identity. */
export class DriveAuthExpiredError extends Error {
  constructor() {
    super('Google Drive authorization expired');
    this.name = 'DriveAuthExpiredError';
  }
}

export interface DriveFile {
  id: string;
  name: string;
}

async function driveFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new DriveAuthExpiredError();
  if (!res.ok) {
    throw new Error(`Google Drive request failed (${res.status})`);
  }
  return res;
}

/** Every backup blob this app has written for this Google account. */
export async function listBackups(token: string): Promise<DriveFile[]> {
  const url = `${FILES_URL}?spaces=appDataFolder&pageSize=100&fields=${encodeURIComponent(
    'files(id,name)',
  )}`;
  const res = await driveFetch(url, token);
  const json = (await res.json()) as { files?: DriveFile[] };
  return json.files ?? [];
}

/** Fetch one blob's ciphertext. */
export async function downloadBackup(token: string, fileId: string): Promise<string> {
  const res = await driveFetch(`${FILES_URL}/${encodeURIComponent(fileId)}?alt=media`, token);
  return res.text();
}

/**
 * Write a new blob. Deliberately always a fresh random filename rather than
 * overwriting: a create can't lose a race with a concurrent create the way a
 * read-modify-write can, and restore tries every file anyway.
 */
export async function uploadBackup(token: string, payload: string): Promise<string> {
  const name = `bmb_bk_${crypto.randomUUID()}.bin`;
  const boundary = `bmb${crypto.randomUUID().replace(/-/g, '')}`;
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify({ name, parents: ['appDataFolder'] })}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n' +
    `${payload}\r\n` +
    `--${boundary}--`;

  const res = await driveFetch(`${UPLOAD_URL}?uploadType=multipart&fields=id`, token, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const json = (await res.json()) as { id?: string };
  if (!json.id) throw new Error('Google Drive did not return a file id');
  return json.id;
}
