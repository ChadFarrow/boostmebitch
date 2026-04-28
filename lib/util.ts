// Coerce an unknown thrown value into a user-readable string. Use for the
// fallback in `catch (e) { return { error: getErrorMessage(e, '<x> failed') } }`
// patterns in API routes and UI handlers.
export function getErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === 'string' && e) return e;
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}
