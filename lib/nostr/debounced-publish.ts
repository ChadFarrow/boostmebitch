/** Returns a debounced publish scheduler for a single event type. */
export function createScheduledPublish(label: string) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return function schedule(fn: () => Promise<unknown>, delayMs = 1500) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn().catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.warn(`[${label}] publish failed:`, (e as Error)?.message ?? e);
      });
    }, delayMs);
  };
}
