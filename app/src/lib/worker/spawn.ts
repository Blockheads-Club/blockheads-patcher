// Creates the real module worker (Vite bundles it via the `new URL(..., import.meta.url)` pattern).
import type { WorkerLike } from './client';

export function spawnApkWorker(): WorkerLike {
  return new Worker(new URL('./apk.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}
