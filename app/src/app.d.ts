declare global {
  namespace App {}
  /** App version from package.json, injected by Vite (see vite.config.ts). */
  const __APP_VERSION__: string;
}
export {};
