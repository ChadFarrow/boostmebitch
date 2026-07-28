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
    // Surface Google's own explanation. A bare status is unactionable — a 403
    // is "the Drive API isn't enabled on this project", "the token lacks the
    // drive.appdata scope", and "rate limited" all at once, and only the body
    // says which. Failing to read it is not fatal, so the status still stands
    // on its own.
    let reason = '';
    try {
      const body = (await res.json()) as { error?: { message?: string; status?: string } };
      reason = body.error?.message ?? '';
    } catch { /* non-JSON body — the status is all we have */ }
    throw new Error(
      reason
        ? `Google Drive request failed (${res.status}): ${reason}`
        : `Google Drive request failed (${res.status})`,
    );
  }
  return res;
}

// Drive caps files.list at 100 per page whatever we ask for, and this app
// writes one blob per identity ever created under a Google account (uploads are
// always creates, never overwrites). Ignoring nextPageToken means identity 101
// is simply unreachable — and a returning user who can't see their backup is
// exactly the person who goes on to create a duplicate.
const BACKUP_PAGE_SIZE = 100;
// Hard cap so a pathological account can't turn sign-in into an unbounded walk.
// orderBy puts the newest first, so a truncated walk drops the blobs least
// likely to be wanted rather than an arbitrary slice — Drive's default ordering
// is unspecified.
const MAX_BACKUP_PAGES = 10;

/** Every backup blob this app has written for this Google account. */
export async function listBackups(token: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_BACKUP_PAGES; page++) {
    const params = new URLSearchParams({
      spaces: 'appDataFolder',
      pageSize: String(BACKUP_PAGE_SIZE),
      orderBy: 'createdTime desc',
      // nextPageToken has to be named explicitly: a fields mask that omits it
      // makes every response look like the last page.
      fields: 'nextPageToken,files(id,name)',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await driveFetch(`${FILES_URL}?${params}`, token);
    const json = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
    if (json.files?.length) files.push(...json.files);
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return files;
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
 *
 * Blobs accumulate and there is deliberately **no delete path**. `decryptNsec`
 * fails identically for "this blob belongs to a different PIN (shared Google
 * account)" and "this blob belongs to a PIN the user has forgotten" — so any
 * prune is a chance to permanently destroy a recoverable identity. The only
 * safe prune would be "delete a blob we just decrypted and re-uploaded," which
 * is a separate feature, not a cleanup.
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
