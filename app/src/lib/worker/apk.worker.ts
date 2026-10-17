// Dedicated worker entry: load/patch/sign off the UI thread. Logic lives in handler.ts.
import { createHandler } from './handler';
import type { Request } from './protocol';

const scope = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent<Request>) => void) | null };
const handle = createHandler((msg, transfer) => scope.postMessage(msg, transfer ?? []));
scope.onmessage = (e) => { void handle(e.data); };
