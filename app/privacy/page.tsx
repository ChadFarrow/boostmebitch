import type { Metadata } from 'next';
import Link from 'next/link';
import { BRAND } from '@/lib/brand';

// Required for Google OAuth app verification: the privacy policy has to be
// hosted on the same domain as the homepage, linked FROM the homepage, and the
// identical URL entered on the OAuth consent screen. See the Google onboarding
// section in CLAUDE.md.
//
// Keep this page factually tied to what the code actually does. Every claim
// below is checkable against the source, and several of them (we never receive
// your name or email; we cannot decrypt your backup) are only true because of
// specific implementation choices — if those change, this page has to change
// with them.

export const metadata: Metadata = {
  title: `Privacy Policy — ${BRAND.displayName}`,
  description:
    `What ${BRAND.displayName} stores, what it sends, and what it deliberately never receives.`,
};

const UPDATED = '28 July 2026';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-display text-lg text-bolt">{title}</h2>
      <div className="flex flex-col gap-2 text-sm leading-relaxed text-bone/90">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main className="max-w-2xl mx-auto px-4 py-10 flex flex-col gap-8 pb-32 pt-[calc(2.5rem+env(safe-area-inset-top))]">
      <div className="flex flex-col gap-2">
        {/* `py-1.5` is a TOUCH TARGET — this is the page's only way back, and
            at text-xs with no vertical padding it was a 16px-tall box. */}
        <Link href="/" className="text-xs text-muted hover:text-bone w-fit py-1.5">
          ← back to {BRAND.displayName}
        </Link>
        <h1 className="headline text-3xl">Privacy Policy</h1>
        <p className="text-xs text-muted">Last updated {UPDATED}</p>
      </div>

      <Section title="The short version">
        <p>
          {BRAND.displayName} has no user accounts, no analytics, and no tracking. There is no
          database of users, because there are no users to put in one — everything that
          identifies you lives in your own browser, your own Nostr identity, or your own
          Lightning wallet.
        </p>
        <p>
          If you sign in with Google, we use it as encrypted storage, not as an identity
          provider. We never receive your name, your email address, or your profile photo.
        </p>
      </Section>

      <Section title="What we never receive">
        <ul className="list-disc pl-5 flex flex-col gap-1">
          <li>Your name, email address, or Google profile photo.</li>
          <li>Your Nostr private key.</li>
          <li>Your PIN.</li>
          <li>Your Lightning wallet credentials.</li>
        </ul>
        <p>
          The Google sign-in requests exactly two scopes: <code>openid</code> and{' '}
          <code>drive.appdata</code>. Neither one grants access to your name or email, and we
          do not request the scopes that would.
        </p>
      </Section>

      <Section title="Google sign-in and Google Drive">
        <p>
          Signing in with Google is optional. It exists for people who want to use Nostr but
          have no Nostr key yet. When you use it:
        </p>
        <ul className="list-disc pl-5 flex flex-col gap-1">
          <li>
            A Nostr key is generated <strong>locally, at random, in your browser</strong>.
            Nothing about it is derived from your Google account.
          </li>
          <li>
            That key is encrypted with a key derived from <strong>your PIN</strong>, which
            never leaves your device and which we never see or store.
          </li>
          <li>
            Only the resulting <strong>encrypted blob</strong> is uploaded to your Google
            Drive, into the hidden <code>appDataFolder</code> — a private space only this app
            can read. It is not visible in your normal Drive files and counts against no
            visible storage.
          </li>
          <li>
            Your Google account ID (the <code>sub</code> claim) is used only as salt for that
            encryption. It is held in memory for the duration of sign-in and is never written
            to disk or transmitted to us.
          </li>
        </ul>
        <p>
          We cannot decrypt your backup. Neither can Google. Only someone with both your
          Google account and your PIN can. This also means that{' '}
          <strong>if you forget your PIN, that account cannot be recovered by anyone</strong>,
          including us.
        </p>
        <p>
          {BRAND.displayName}&apos;s use and transfer of information received from Google APIs
          adheres to the{' '}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="underline hover:text-bolt"
            target="_blank"
            rel="noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </Section>

      <Section title="What stays on your device">
        <p>
          App settings, favorites, mute lists, your sent-boost log, wallet connection details,
          and — if you used Google sign-in — your encrypted Nostr key all live in your
          browser&apos;s local storage and IndexedDB. None of it is sent to us. Clearing your
          browser data for this site removes it.
        </p>
      </Section>

      <Section title="What is public by design">
        <p>
          Nostr is a public protocol. Anything you publish through this app — boost notes,
          comments, your profile, your follow list, your public mutes — is broadcast to Nostr
          relays operated by third parties, where it is readable by anyone and may be copied,
          cached, and rebroadcast indefinitely. Deletion requests exist in Nostr but relays
          honor them at their own discretion.{' '}
          <strong>Treat anything you publish as permanent and public.</strong>
        </p>
        <p>
          Lightning payments go directly from your wallet to the recipient. We do not route,
          hold, or take a cut of any payment. Boost metadata you choose to send (your typed
          &ldquo;from&rdquo; name, your message) travels with the payment to the recipient.
        </p>
      </Section>

      <Section title="Servers we do talk to">
        <ul className="list-disc pl-5 flex flex-col gap-1">
          <li>
            <strong>Podcast Index</strong> — podcast search and feed data is proxied through
            our server so that API credentials never reach your browser. Those requests carry
            your search terms and, as with any web request, your IP address.
          </li>
          <li>
            <strong>Nostr relays, Lightning services, podcast hosts, and artwork hosts</strong>{' '}
            — contacted directly by your browser, and each will see your IP address. We do not
            control these third parties.
          </li>
          <li>
            <strong>Google</strong> — only if you use Google sign-in, and only as described
            above.
          </li>
        </ul>
        <p>
          The site is hosted on Vercel, which keeps standard server logs. We do not run
          analytics, advertising, or third-party tracking scripts.
        </p>
      </Section>

      <Section title="Deleting your data">
        <ul className="list-disc pl-5 flex flex-col gap-1">
          <li>
            <strong>Local data</strong> — sign out, or clear site data in your browser. Signing
            out of a Google-created account erases that key from the browser permanently.
          </li>
          <li>
            <strong>Your Google Drive backup</strong> — in Google Drive, open{' '}
            <em>Settings → Manage apps</em>, find this app, and choose{' '}
            <em>Delete hidden app data</em>. You can also revoke the app entirely at{' '}
            <a
              href="https://myaccount.google.com/permissions"
              className="underline hover:text-bolt"
              target="_blank"
              rel="noreferrer"
            >
              myaccount.google.com/permissions
            </a>
            .
          </li>
          <li>
            <strong>Published Nostr events</strong> — cannot be reliably deleted, as described
            above.
          </li>
        </ul>
      </Section>

      <Section title="Children">
        <p>
          This app is not directed at children under 13, and we do not knowingly collect
          information from them.
        </p>
      </Section>

      <Section title="Changes and contact">
        <p>
          If this policy changes materially, the date at the top of this page changes with it.
        </p>
        <p>
          Questions: <a href="mailto:chad.farrow@gmail.com" className="underline hover:text-bolt">chad.farrow@gmail.com</a>
        </p>
      </Section>
    </main>
  );
}
