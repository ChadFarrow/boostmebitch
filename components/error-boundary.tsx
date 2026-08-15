'use client';
import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A class error boundary, because React still offers no hook equivalent.
 *
 * WHY: `app/error.tsx` is a **route-segment** boundary, so it only catches
 * throws from inside `app/page.tsx`'s tree. `<Player>` is mounted in
 * `app/layout.tsx`, OUTSIDE that segment — and it is the most stateful
 * component in the app, ~950 lines driven by arbitrary third-party feed data
 * (enclosure URLs, HLS manifests, chapter JSON, value blocks). A throw there
 * escaped every boundary in the repo and replaced the whole document with
 * Next's default "Application error" page, taking the browse UI down with it.
 *
 * Losing playback should cost you playback, not the app.
 *
 * `resetKey` remounts the subtree when it changes — pass the current episode id
 * so moving to a different episode clears a fault caused by the previous one,
 * rather than leaving the user stuck with a dead player until a full reload.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode; resetKey?: string | number; label?: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`[boundary] ${this.props.label ?? 'subtree'} threw:`, error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string | number }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
