import { loadPack, registryWithPacks, type PackConflict, type PackIssue, type Patch } from '@bh-patcher/core';
import { setExtraMessages } from './i18n';
import type { Engine, LoadedPack } from './engine';
import { memoryPackStore } from './platform/packs-idb';
import type { PackStore } from './platform/types';

/** Why an import or a stored pack was refused. */
export interface PackProblem { name: string; issues: PackIssue[] }

/** i18n messages for the texts that pack patches carry (`patch.<id>.name|summary|description`). */
export function patchMessages(patches: Patch[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const p of patches)
    for (const [lang, x] of Object.entries(p.texts ?? {})) {
      const d = (out[lang] ??= {});
      d[`patch.${p.id}.name`] = x.name;
      d[`patch.${p.id}.summary`] = x.summary;
      d[`patch.${p.id}.description`] = x.description;
    }
  return out;
}

const issue = (message: string): PackIssue[] => [{ code: 'notZip', message }];

/**
 * Imported patch packs: validated, persisted through the platform's PackStore and handed to the engine. `onchange`
 * runs after every change (the patcher refreshes its list of patches).
 */
export class PacksState {
  items = $state.raw<LoadedPack[]>([]);
  /** Stored packs this version can no longer load (kept until removed). */
  broken = $state.raw<(PackProblem & { id: string })[]>([]);
  conflicts = $state.raw<PackConflict[]>([]);
  /** Result of the last import: the refused file, or null. */
  problem = $state.raw<PackProblem | null>(null);
  busy = $state(false);
  readonly store: PackStore;

  constructor(store: PackStore | undefined, private readonly engine: Engine, private readonly onchange: () => Promise<void> = async () => {}) {
    this.store = store ?? memoryPackStore();
  }

  /** Loads the stored packs (boot). */
  async init(): Promise<void> {
    const items: LoadedPack[] = [];
    const broken: (PackProblem & { id: string })[] = [];
    for (const { id, bytes } of await this.store.list()) {
      const r = loadPack(bytes);
      if (r.ok) items.push({ pack: r.pack, bytes });
      else broken.push({ id, name: `${id}.bhpack`, issues: r.errors });
    }
    this.broken = broken;
    await this.commit(items);
  }

  /** Validates and stores a pack; a pack with the same id is replaced. Returns true when it was imported. */
  async import(name: string, bytes: Uint8Array): Promise<boolean> {
    this.busy = true;
    this.problem = null;
    const ok = await this.add(name, bytes);
    this.busy = false;
    return ok;
  }

  private async add(name: string, bytes: Uint8Array): Promise<boolean> {
    try {
      const r = loadPack(bytes);
      if (!r.ok) { this.problem = { name, issues: r.errors }; return false; }
      await this.store.put(r.pack.id, bytes);
      this.broken = this.broken.filter((b) => b.id !== r.pack.id);
      await this.commit([...this.items.filter((x) => x.pack.id !== r.pack.id), { pack: r.pack, bytes }]);
      return true;
    } catch (e) {
      this.problem = { name, issues: issue(e instanceof Error ? e.message : String(e)) };
      return false;
    }
  }

  async remove(id: string): Promise<void> {
    await this.store.remove(id);
    this.broken = this.broken.filter((b) => b.id !== id);
    await this.commit(this.items.filter((x) => x.pack.id !== id));
  }

  private async commit(items: LoadedPack[]): Promise<void> {
    const packs = items.map((x) => x.pack);
    setExtraMessages(patchMessages(packs.flatMap((p) => p.patches)));
    this.conflicts = registryWithPacks(packs).conflicts;
    this.items = items;
    await this.engine.setPacks(items);
    await this.onchange();
  }
}
