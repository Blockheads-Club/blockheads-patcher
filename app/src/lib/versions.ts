import type { Patch } from '@bh-patcher/core';

/** A patch version for display: the patch's own label (`0.3.1`) or `v<n>`. */
export const patchVersionText = (patch: Pick<Patch, 'versionLabel'>, v: number): string => (patch.versionLabel ? patch.versionLabel(v) : `v${v}`);
