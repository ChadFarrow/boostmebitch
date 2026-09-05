// Hand a URI to whatever app on the device claims its scheme.
//
// ONE COPY, because there are now three callers and the drift would be
// invisible: the Amber button, the Clave button, and the header row that
// launches Clave without opening the modal first. CLAUDE.md's "one place per
// thing" table exists for exactly this shape.
//
// AN ANCHOR CLICK, NOT `location.href = uri`. Some Android browsers hand a
// custom scheme to the intent picker reliably from a click and silently drop it
// as a "navigation hint" from an assignment — lib/nostr/amber.ts carries the
// measurement. iOS Safari wants the same shape.
//
// IT MUST BE CALLED INSIDE THE CLICK, and that is the whole reason it is a
// separate module rather than something a component does on mount. Safari gates
// an app-scheme navigation on transient activation, and React schedules effects
// in a LATER TASK — the same fault that made every first Google sign-in fail
// (docs/signers.md, "Nothing may await the script and THEN ask for the popup").
// A caller that wants an app opened calls this first, synchronously, and lets
// the UI catch up afterwards.
//
// THERE IS NO FAILURE SIGNAL. A scheme nothing has registered is a silent
// no-op: no error, no navigation event, nothing observable. So a caller cannot
// learn whether the app exists from this function, and must not try — the
// `document.hidden` race that looks like a test reports "not installed" for any
// slow app switch, which is the ordinary case for a signer being cold-launched.
export function openAppLink(uri: string) {
  const a = document.createElement('a');
  a.href = uri;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
