import { NextResponse } from 'next/server';
import { getErrorMessage } from './util';

/** Wrap a route handler body so unhandled throws return a consistent 500 JSON. */
export async function withErrorHandling(
  fn: () => Promise<NextResponse>,
  fallback: string,
): Promise<NextResponse> {
  try {
    return await fn();
  } catch (e) {
    return NextResponse.json({ error: getErrorMessage(e, fallback) }, { status: 500 });
  }
}
