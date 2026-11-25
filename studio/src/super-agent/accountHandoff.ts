import type { AccountSummary } from '../../../shared/provider-directory';

export type AccountHandoffFailure = 'timeout' | 'cancelled' | 'connector_unavailable' | 'start_failed' | 'plan_open_failed' | 'continue_failed' | 'unknown';
export type AccountHandoffState =
  | { status: 'idle' | 'starting' | 'signed_in' | 'opening_plan' | 'done' }
  | { status: 'authorizing'; authorizationUrl?: string; userCode?: string; browserOpened?: boolean }
  | { status: 'awaiting_upgrade'; planUrl?: string }
  | { status: 'resuming'; plan?: string }
  | { status: 'failed'; reason: AccountHandoffFailure; phase?: 'sign_in' | 'upgrade'; message?: string };

import { planMediaEntitlement } from '../../../shared/account-plan';

// Same classification as the gateway (shared/account-plan.ts); enforcement stays in the gateway.
export { planMediaEntitlement };

export function accountHandoffReducer(state: AccountHandoffState, summary: AccountSummary): AccountHandoffState {
  if (state.status === 'awaiting_upgrade' || (state.status === 'failed' && state.phase === 'upgrade')) {
    return summary.state === 'signed-in' && !summary.billingUnavailable && planMediaEntitlement(summary.plan) === 'included'
      ? { status: 'resuming', plan: summary.plan } : state;
  }
  if (state.status !== 'starting' && state.status !== 'authorizing' && state.status !== 'signed_in') return state;
  if (summary.state === 'signed-in') {
    return !summary.billingUnavailable && planMediaEntitlement(summary.plan) === 'not-included'
      ? { status: 'opening_plan' } : { status: 'resuming', plan: summary.plan };
  }
  if (summary.state === 'authorizing') {
    return { status: 'authorizing', authorizationUrl: summary.authorizationUrl, userCode: summary.userCode, browserOpened: summary.browserOpened };
  }
  const reason: AccountHandoffFailure = summary.errorCode === 'connector_unavailable' ? 'connector_unavailable'
    : summary.errorCode === 'authorization_expired' ? 'timeout'
    : summary.errorCode === 'setup_failed' ? 'start_failed'
    : summary.errorCode ? 'unknown'
    : summary.state === 'signed-out' || summary.state === 'reauth-required' ? 'cancelled' : 'unknown';
  return { status: 'failed', reason, message: summary.error };
}
