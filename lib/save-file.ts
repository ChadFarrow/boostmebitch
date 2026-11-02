/**
 * Hand the browser a file to save. BROWSER-ONLY.
 *
 * One place for the two details that are not decoration, because the second
 * download in this app (the OPML export) would otherwise be the copy that
 * forgets one of them:
 *
 *  - The anchor is APPENDED to the document before the click. Firefox ignores
 *    a click on a detached anchor, and the download then silently never starts.
 *  - The object URL is revoked on the NEXT macrotask. Revoking inside the same
 *    task can cancel a download the browser has not yet taken. The timeout
 *    touches no React state, so an unmount in between needs no `clearTimeout`.
 */
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
