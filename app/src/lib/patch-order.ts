// Display order of the review list: the mod loader first, then the recommended fixes, then the optional ones and pack
// patches. The order patches are applied in stays the registry's (the selection keeps it), only the list moves.
import type { ApplicableReport } from '@bh-patcher/core';

const rank = ({ patch }: ApplicableReport[number]): number =>
  patch.id === 'mod-loader' ? 0 : patch.source ? 3 : patch.optIn ? 2 : 1;

export const displayOrder = (report: ApplicableReport): ApplicableReport =>
  report.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map(({ r }) => r);
