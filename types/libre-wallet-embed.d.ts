// Hand-written declaration for @libre/wallet-embed, transcribed from the
// Libre monorepo's embed-integration guide. Authored in an environment where
// the release tarball couldn't be downloaded, so this is the *documented*
// contract rather than generated types. An ambient `declare module` wins
// module resolution over the package's own dist/*.d.ts — after the first
// real install, verify it against the shipped types and update (or delete
// this file) if they disagree.
declare module '@libre/wallet-embed' {
  /** Views named by the integration guide; the widget may grow more. */
  export type LibreWalletView = 'running' | 'stopped' | 'moved-away' | (string & {});

  export interface LibreWalletState {
    view: LibreWalletView;
  }

  export interface MountLibreWalletOptions {
    /** Google OAuth client id of the Libre wallet web client (not a secret). */
    googleClientId: string;
    /** URL the LDK WASM binary is served from (copied to public/ on install). */
    wasmUrl: string;
    /** Shown by the standalone PWA as "active on <origin>" context. */
    appName: string;
    /** Install the wallet's WebLN provider at window.webln. */
    installWebln?: boolean;
  }

  export interface LibreWalletHandle {
    dispose(): Promise<void>;
    onState?: (cb: (s: LibreWalletState) => void) => () => void;
  }

  /** The guide calls this synchronously; typed to tolerate a promise too. */
  export function mountLibreWallet(
    el: HTMLElement,
    opts: MountLibreWalletOptions,
  ): LibreWalletHandle | Promise<LibreWalletHandle>;
}
