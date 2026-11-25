import { describe, expect, it } from 'vitest';
import type { AccountSummary } from '../../../shared/provider-directory';
import { accountHandoffReducer, planMediaEntitlement, type AccountHandoffState } from './accountHandoff';

const summary = (value: Partial<AccountSummary>): AccountSummary => ({ state: 'signed-in', consoleUrl: '', ...value });
const authorizing: AccountHandoffState = { status: 'authorizing' };

describe('account handoff reducer', () => {
  it.each(['plus', 'pro', 'max', ' Plus '])('resumes signed-in %s accounts', plan => {
    expect(accountHandoffReducer(authorizing, summary({ plan }))).toEqual({ status: 'resuming', plan });
  });
  it.each(['free', 'go'])('opens plans for signed-in %s accounts', plan => {
    expect(accountHandoffReducer(authorizing, summary({ plan }))).toEqual({ status: 'opening_plan' });
  });
  it('preserves browser authorization details', () => {
    expect(accountHandoffReducer(authorizing, summary({ state: 'authorizing', authorizationUrl: 'https://example.test/login', userCode: 'CODE', browserOpened: false })))
      .toEqual({ status: 'authorizing', authorizationUrl: 'https://example.test/login', userCode: 'CODE', browserOpened: false });
  });
  it.each([
    ['connector_unavailable', 'connector_unavailable'], ['authorization_expired', 'timeout'],
    ['setup_failed', 'start_failed'], ['credentials_rejected', 'unknown'],
  ] as const)('maps %s to %s', (errorCode, reason) => {
    expect(accountHandoffReducer(authorizing, summary({ state: 'signed-out', errorCode, error: 'Details' })))
      .toEqual({ status: 'failed', reason, message: 'Details' });
  });
  it('treats signed-out without an error code as cancellation', () => {
    expect(accountHandoffReducer(authorizing, summary({ state: 'signed-out' }))).toMatchObject({ status: 'failed', reason: 'cancelled' });
  });
  it.each([{ billingUnavailable: true, plan: 'free' }, { plan: 'enterprise' }, {}])('defers unknown billing to Agent rules: %j', value => {
    expect(accountHandoffReducer(authorizing, summary(value))).toMatchObject({ status: 'resuming' });
  });
  it('waits for a confirmed included plan after opening checkout', () => {
    const waiting: AccountHandoffState = { status: 'awaiting_upgrade', planUrl: 'https://example.test/plans' };
    for (const account of [{ plan: 'free' }, { plan: 'go' }, { plan: 'enterprise' }, { plan: 'plus', billingUnavailable: true }, { state: 'signed-out' as const }]) {
      expect(accountHandoffReducer(waiting, summary(account))).toBe(waiting);
    }
    expect(accountHandoffReducer(waiting, summary({ plan: 'plus' }))).toEqual({ status: 'resuming', plan: 'plus' });
  });
  it.each(['timeout', 'plan_open_failed'] as const)('allows a manual entitlement check after an upgrade %s', reason => {
    const failed: AccountHandoffState = { status: 'failed', reason, phase: 'upgrade' };
    for (const value of [{ plan: 'free' }, { plan: 'go' }, { plan: 'plus', billingUnavailable: true }, { plan: 'unknown' }]) {
      expect(accountHandoffReducer(failed, summary(value))).toBe(failed);
    }
    expect(accountHandoffReducer(failed, summary({ plan: 'plus' }))).toEqual({ status: 'resuming', plan: 'plus' });
  });
  it('does not revive a sign-in failure on a background account read', () => {
    const failed: AccountHandoffState = { status: 'failed', reason: 'timeout', phase: 'sign_in' };
    expect(accountHandoffReducer(failed, summary({ plan: 'plus' }))).toBe(failed);
  });
  it('ignores summaries outside an active flow', () => {
    for (const status of ['idle', 'opening_plan', 'done'] as const) {
      const state = { status };
      expect(accountHandoffReducer(state, summary({ plan: 'plus' }))).toBe(state);
    }
    expect(planMediaEntitlement('GO')).toBe('not-included');
    expect(planMediaEntitlement()).toBe('unknown');
  });
});
