import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountSummary } from '../../../shared/provider-directory';
import type { SuperAgentActionCard } from '../../../shared/super-agent';
import { gatewayRequest } from '../motion/gatewayClient';
import { newTrackingId } from '../motion/pageTracking';
import { notifyProvidersChanged } from '../motion/useProviderDirectory';
import { accountHandoffReducer, planMediaEntitlement, type AccountHandoffState } from './accountHandoff';

export type AccountHandoffResume = (card: SuperAgentActionCard, account: { plan?: string }) => void | Promise<unknown>;
const LOGIN_TIMEOUT = 5 * 60_000;
const UPGRADE_TIMEOUT = 20 * 60_000;

export function useAccountHandoff(card: SuperAgentActionCard, onResume?: AccountHandoffResume) {
  const [state, setState] = useState<AccountHandoffState>({ status: 'idle' });
  const [alreadySignedIn, setAlreadySignedIn] = useState(false);
  const current = useRef(state);
  const mounted = useRef(false);
  const generation = useRef(0);
  const entryId = useRef('');
  const deadline = useRef(0);
  const resumed = useRef(new Set<string>());
  const resume = useRef(onResume);
  resume.current = onResume;
  const polling = useRef<object | null>(null);
  const cancellation = useRef<Promise<unknown> | null>(null);

  const transition = useCallback((next: AccountHandoffState) => {
    if (!mounted.current) return;
    current.current = next;
    setState(next);
  }, []);
  const isCurrent = useCallback((run: number) => mounted.current && generation.current === run, []);
  // Right after sign-in the connector may report signed-in before its first billing read lands (no plan yet).
  // Read once with refresh so Free/Go accounts are not mistaken for "unknown plan" and resumed without the plans page.
  const withPlan = useCallback(async (summary: AccountSummary) => (
    summary.state === 'signed-in' && !summary.billingUnavailable && !summary.plan
      ? gatewayRequest<AccountSummary>('settings/account?refresh=true').catch(() => summary)
      : summary
  ), []);
  const notify = useCallback(() => {
    notifyProvidersChanged();
    window.dispatchEvent(new Event('motion:account-changed'));
  }, []);

  useEffect(() => {
    mounted.current = true;
    const run = ++generation.current;
    current.current = { status: 'idle' };
    setState(current.current);
    setAlreadySignedIn(false);
    // A restored card never resumes by itself. Its initial read only changes the idle CTA.
    void gatewayRequest<AccountSummary>('settings/account').then(summary => {
      if (isCurrent(run) && current.current.status === 'idle') {
        setAlreadySignedIn(summary.state === 'signed-in' && !summary.billingUnavailable && planMediaEntitlement(summary.plan) === 'included');
      }
    }).catch(() => {});
    return () => { mounted.current = false; generation.current++; };
  }, [card.id, isCurrent]);

  const start = useCallback(async (target: SuperAgentActionCard = card) => {
    if (!mounted.current || !['idle', 'failed'].includes(current.current.status)) return;
    const previous = current.current;
    const reopenPlans = previous.status === 'failed' && previous.phase === 'upgrade';
    const run = ++generation.current;
    entryId.current = newTrackingId();
    polling.current = null;
    // Checkout failures reopen plans. Everything else (including upgrade cards) first confirms the local
    // sign-in: a web checkout cannot sign the local connector in, so a signed-out upgrade card signs in first.
    if (reopenPlans) {
      deadline.current = Date.now() + UPGRADE_TIMEOUT;
      transition({ status: 'opening_plan' });
      return;
    }
    deadline.current = Date.now() + LOGIN_TIMEOUT;
    transition({ status: 'starting' });
    try {
      await cancellation.current;
      if (!isCurrent(run)) return;
      let summary = await gatewayRequest<AccountSummary>('settings/account');
      if (!isCurrent(run)) return;
      if (summary.state !== 'signed-in') {
        summary = await gatewayRequest<AccountSummary>('settings/account/login', 'POST', { hookId: 'super_agent_signin', entryId: entryId.current });
      }
      if (!isCurrent(run)) return;
      summary = await withPlan(summary);
      if (!isCurrent(run)) return;
      if (summary.state === 'signed-in') notify();
      const next = accountHandoffReducer({ status: 'starting' }, summary);
      if (next.status === 'opening_plan') deadline.current = Date.now() + UPGRADE_TIMEOUT;
      transition(next);
    } catch (error) {
      if (isCurrent(run)) transition({ status: 'failed', reason: 'start_failed', message: error instanceof Error ? error.message : undefined });
    }
  }, [card, isCurrent, notify, transition, withPlan]);

  const refresh = useCallback(async () => {
    const previous = current.current;
    const upgrade = previous.status === 'awaiting_upgrade' || (previous.status === 'failed' && previous.phase === 'upgrade');
    if (previous.status !== 'authorizing' && !upgrade) return;
    if (polling.current) return;
    const request = {};
    polling.current = request;
    const run = generation.current;
    try {
      let summary = await gatewayRequest<AccountSummary>('settings/account' + (upgrade ? '?refresh=true' : ''));
      if (!isCurrent(run) || current.current.status !== previous.status) return;
      if (!upgrade) summary = await withPlan(summary);
      if (!isCurrent(run) || current.current.status !== previous.status) return;
      const next = accountHandoffReducer(current.current, summary);
      if (summary.state === 'signed-in' && (previous.status === 'authorizing' || next.status === 'resuming')) notify();
      if (next.status === 'opening_plan') deadline.current = Date.now() + UPGRADE_TIMEOUT;
      transition(next);
    } catch {
      // Transient read failures do not cancel an otherwise valid browser handoff; the deadline still applies.
    } finally {
      if (polling.current === request) polling.current = null;
    }
  }, [isCurrent, notify, transition, withPlan]);

  useEffect(() => {
    if (state.status !== 'opening_plan') return;
    const run = generation.current;
    let active = true;
    void gatewayRequest<{ url: string; opened: boolean }>('settings/account/subscription', 'POST', { hookId: 'super_agent_upgrade', entryId: entryId.current }).then(({ url, opened }) => {
      if (!active || !isCurrent(run)) return;
      let planUrl: string | undefined;
      if (!opened) {
        try {
          const page = window.open(url, '_blank');
          if (page) page.opener = null;
          else planUrl = url;
        } catch { planUrl = url; }
      }
      deadline.current = Date.now() + UPGRADE_TIMEOUT;
      transition({ status: 'awaiting_upgrade', planUrl });
    }).catch(error => {
      if (active && isCurrent(run)) transition({ status: 'failed', reason: 'plan_open_failed', phase: 'upgrade', message: error instanceof Error ? error.message : undefined });
    });
    return () => { active = false; };
  }, [state.status, isCurrent, transition]);

  useEffect(() => {
    const login = state.status === 'starting' || state.status === 'authorizing';
    const upgrade = state.status === 'opening_plan' || state.status === 'awaiting_upgrade';
    if (!login && !upgrade) return;
    const run = generation.current;
    const timer = window.setTimeout(() => {
      if (!isCurrent(run)) return;
      const status = current.current.status;
      if (login ? status !== 'starting' && status !== 'authorizing' : status !== 'opening_plan' && status !== 'awaiting_upgrade') return;
      generation.current++;
      polling.current = null;
      transition({ status: 'failed', reason: 'timeout', phase: upgrade ? 'upgrade' : 'sign_in' });
      if (login) cancellation.current = gatewayRequest('settings/account/cancel', 'POST').catch(() => {});
    }, Math.max(0, deadline.current - Date.now()));
    return () => window.clearTimeout(timer);
  }, [state.status, isCurrent, transition]);

  useEffect(() => {
    if (state.status !== 'authorizing' && state.status !== 'awaiting_upgrade') return;
    const timer = window.setInterval(() => void refresh(), state.status === 'authorizing' ? 2_000 : 5_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const onFocus = () => void refresh();
    if (state.status === 'awaiting_upgrade') {
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onVisible);
    }
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [state.status, refresh]);

  useEffect(() => {
    if (state.status !== 'resuming') return;
    const run = generation.current;
    if (resumed.current.has(card.id)) { transition({ status: 'done' }); return; }
    resumed.current.add(card.id);
    // Reserve the card before invoking the callback, including synchronous callbacks and Strict Mode effects.
    void Promise.resolve().then(() => {
      if (isCurrent(run)) return resume.current?.(card, { plan: state.plan });
    }).then(() => {
      if (isCurrent(run)) transition({ status: 'done' });
    }).catch(error => {
      resumed.current.delete(card.id);
      if (isCurrent(run)) transition({ status: 'failed', reason: 'unknown', message: error instanceof Error ? error.message : undefined });
    });
  }, [state, card, isCurrent, transition]);

  const cancel = useCallback(async () => {
    if (current.current.status !== 'authorizing') return;
    const run = ++generation.current;
    polling.current = null;
    // Ignore a poll already in flight while the connector cancels the attempt.
    transition({ status: 'idle' });
    cancellation.current = gatewayRequest('settings/account/cancel', 'POST').catch(() => {});
    await cancellation.current;
    if (isCurrent(run)) setAlreadySignedIn(false);
  }, [isCurrent, transition]);

  return { state, alreadySignedIn, start, retry: () => start(card), cancel, refresh };
}
