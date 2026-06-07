/** Creates a simple observable: subscribe + notify pattern. */
export function createObservable() {
  const listeners = new Set<() => void>();
  return {
    notify() {
      listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
