/**
 * Advisory plan → media-entitlement classification shared by the gateway and Studio.
 * The gateway stays the enforcement point; Studio only uses this to pick the next UI step.
 */
export type PlanMediaEntitlement = 'included' | 'not-included' | 'unknown';

export function planMediaEntitlement(plan?: string): PlanMediaEntitlement {
  const normalized = plan?.trim().toLowerCase();
  if (normalized === 'plus' || normalized === 'pro' || normalized === 'max') return 'included';
  if (normalized === 'free' || normalized === 'go') return 'not-included';
  return 'unknown';
}
