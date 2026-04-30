'use client';
import { useState } from 'react';
import { DefaultAvatar } from './default-avatar';

// Picture-with-fallback: renders the user's `<img>` when present, swaps to
// DefaultAvatar on load failure (broken URL, blocked host, expired CDN link)
// or when no picture is provided at all. Pass the same className you'd give
// either branch — sizing / rounded / border classes are shared, and this
// component adds `object-cover` for the img path and flex-centering for the
// fallback path internally.
export function Avatar({
  pubkey,
  picture,
  name,
  className,
}: {
  pubkey: string;
  picture?: string | null;
  name?: string | null;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);
  if (picture && !errored) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={picture}
        alt=""
        className={`${className ?? ''} object-cover`}
        onError={() => setErrored(true)}
      />
    );
  }
  return <DefaultAvatar pubkey={pubkey} name={name} className={className} />;
}
