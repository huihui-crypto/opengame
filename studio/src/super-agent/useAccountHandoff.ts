import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountSummary } from '../../../shared/provider-directory';
import type { SuperAgentActionCard } from '../../../shared/super-agent';
import { gatewayRequest } from '../motion/gatewayClient';
import { newCampaignEntryId } from '../motion/campaignAttribution';
import { reportEntitlementRefresh } from '../motion/pageTracking';
import { notifyProvidersChanged } from '../motion/useProviderDirectory';
import { accountHandoffReducer, planMediaEntitlement, type AccountHandoffState } from './accountHandoff';

export type AccountHandoffResume = (card: SuperAgentActionCard, account: { plan?: string; key: string }) => void | Promise<unknown>;
const LOGIN_TIMEOUT = 5 * 60_000;
const UPGRADE_TIMEOUT = 20 * 60_000;

// The conversation stream unmounts while the preview is expanded. In-flight handoffs live here, keyed by
// chat + turn + card (gateway card ids repeat across turns and chats), so a remounted card picks up its
// pending request, polling and deadline instead of falling back to idle; resumes stay once per key.
type HandoffSession = { state: AccountHandoffState; entryId: string; deadline: number; plansEntryId: string | null };

/**
 * Same touchpoint hook ids as the commercialization gates (#24), so one funnel covers these cards. Publish sign-in
 * cards reuse the Cloud Share hooks of the publish popover (game_publish_signin for games, cloud_share_signin otherwise).
 */
export function accountHandoffHookId(card: Pick<SuperAgentActionCard, 'kind' | 'targetKind'>) {
  if (card.kind === 'web_publish_sign_in') return card.targetKind === 'game' ? 'game_publish_signin' as const : 'cloud_share_signin' as const;
  return card.kind === 'sign_in' ? 'studio_generate' as const : 'studio_free_gate' as const;
}
const sessions = new Map<string, HandoffSession>();
// One continuation per key, shared by every mount: in flight or succeeded. A failed one is removed so Retry re-sends.
const resumeRuns = new Map<string, Promise<void>>();
/** Test-only: forget in-flight handoffs and resumed cards. */
export function resetAccountHandoffSessions() { sessions.clear(); resumeRuns.clear(); }
function persisted(state: AccountHandoffState) {
  return ['starting', 'signed_in', 'authorizing', 'opening_plan', 'awaiting_upgrade', 'failed'].includes(state.status);
}

export function useAccountHandoff(card: SuperAgentActionCard, onResume?: AccountHandoffResume, handoffKey = card.id) {
  const [state, setState] = useState<AccountHandoffState>({ status: 'idle' });
  const [alreadySignedIn, setAlreadySignedIn] = useState(false);
  // Signed in on Free/Go at mount: an upgrade card can go straight to the pricing link.
  const [signedInForPlans, setSignedInForPlans] = useState(false);
  const [entryIdState, setEntryIdState] = useState('');
  const attempts = useRef(0);
  // entry_id carried by the pricing link the user last opened; its checkout-return refresh reports this id.
  const plansEntryId = useRef<string | null>(null);
  const hookId = useRef(accountHandoffHookId(card));
  hookId.current = accountHandoffHookId(card);
  // Publishing only needs a signed-in account: plan entitlement never applies to publish sign-in cards.
  const signInOnly = card.kind === 'web_publish_sign_in';
  const current = useRef(state);
  const mounted = useRef(false);
  const generation = useRef(0);
  const entryId = useRef('');
  const deadline = useRef(0);
  const key = useRef(handoffKey);
  key.current = handoffKey;
  const resume = useRef(onResume);
  resume.current = onResume;
  const polling = useRef<object | null>(null);
  const cancellation = useRef<Promise<unknown> | null>(null);

  const transition = useCallback((next: AccountHandoffState) => {
    if (!mounted.current) return;
    current.current = next;
    setState(next);
    // A pricing link already used keeps its id; the next one the card renders gets a fresh entry_id.
    if (next.status === 'failed' && next.phase === 'upgrade' && plansEntryId.current === entryId.current) {
      entryId.current = newCampaignEntryId();
      setEntryIdState(entryId.current);
    }
    if (persisted(next)) sessions.set(key.current, { state: next, entryId: entryId.current, deadline: deadline.current, plansEntryId: plansEntryId.current });
    else sessions.delete(key.current);
  }, []);
  const isCurrent = useCallback((run: number) => mounted.current && generation.current === run, []);
  // Right after sign-in the connector may report signed-in before its first billing read lands (no plan yet).
  // Read once with refresh so Free/Go accounts are not mistaken for "unknown plan" and resumed without the plans page.
  const withPlan = useCallback(async (summary: AccountSummary) => (
    !signInOnly && summary.state === 'signed-in' && !summary.billingUnavailable && !summary.plan
      ? gatewayRequest<AccountSummary>('settings/account?refresh=true').catch(() => summary)
      : summary
  ), [signInOnly]);
  const notify = useCallback(() => {
    notifyProvidersChanged();
    window.dispatchEvent(new Event('motion:account-changed'));
  }, []);

  // Confirms the local sign-in, then lets the reducer pick resume / plans / polling. The login POST is
  // idempotent, so a remounted card whose start step was cut short simply runs it again with the same entryId.
  const runStart = useCallback(async (run: number) => {
    try {
      await cancellation.current;
      if (!isCurrent(run)) return;
      let summary = await gatewayRequest<AccountSummary>('settings/account');
      if (!isCurrent(run)) return;
      if (summary.state !== 'signed-in') {
        summary = await gatewayRequest<AccountSummary>('settings/account/login', 'POST', { hookId: hookId.current, entryId: entryId.current });
      }
      if (!isCurrent(run)) return;
      summary = await withPlan(summary);
      if (!isCurrent(run)) return;
      if (summary.state === 'signed-in') notify();
      const next = accountHandoffReducer({ status: 'starting' }, summary, { signInOnly });
      transition(next);
    } catch (error) {
      if (isCurrent(run)) transition({ status: 'failed', reason: 'start_failed', message: error instanceof Error ? error.message : undefined });
    }
  }, [isCurrent, notify, signInOnly, transition, withPlan]);

  useEffect(() => {
    mounted.current = true;
    const run = ++generation.current;
    const saved = sessions.get(handoffKey);
    if (saved) {
      entryId.current = saved.entryId;
      deadline.current = saved.deadline;
      plansEntryId.current = saved.plansEntryId;
      attempts.current = 1;
      setEntryIdState(saved.entryId);
      const restored: AccountHandoffState = saved.state.status === 'signed_in' ? { status: 'starting' } : saved.state;
      current.current = restored;
      setState(restored);
      if (restored.status === 'starting') void runStart(run);
      return () => { mounted.current = false; generation.current++; };
    }
    current.current = { status: 'idle' };
    setState(current.current);
    setAlreadySignedIn(false);
    setSignedInForPlans(false);
    entryId.current = newCampaignEntryId();
    attempts.current = 0;
    setEntryIdState(entryId.current);
    // A restored card never resumes by itself. Its initial read only changes the idle CTA.
    void gatewayRequest<AccountSummary>('settings/account').then(summary => {
      if (isCurrent(run) && current.current.status === 'idle') {
        if (signInOnly) { setAlreadySignedIn(summary.state === 'signed-in'); return; }
        const signedIn = summary.state === 'signed-in' && !summary.billingUnavailable;
        setAlreadySignedIn(signedIn && planMediaEntitlement(summary.plan) === 'included');
        setSignedInForPlans(signedIn && planMediaEntitlement(summary.plan) === 'not-included');
      }
    }).catch(() => {});
    return () => { mounted.current = false; generation.current++; };
  }, [handoffKey, isCurrent, runStart, signInOnly]);

  const start = useCallback(async (target: SuperAgentActionCard = card) => {
    if (!mounted.current || !['idle', 'failed'].includes(current.current.status)) return;
    const previous = current.current;
    const reopenPlans = previous.status === 'failed' && previous.phase === 'upgrade';
    const run = ++generation.current;
    polling.current = null;
    // Checkout failures go back to the plans CTA. Everything else (including upgrade cards) first confirms the
    // local sign-in: a web checkout cannot sign the local connector in, so a signed-out upgrade card signs in first.
    if (reopenPlans) {
      transition({ status: 'opening_plan' });
      return;
    }
    deadline.current = Date.now() + LOGIN_TIMEOUT;
    transition({ status: 'starting' });
    await runStart(run);
  }, [card, runStart, transition]);

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
      const next = accountHandoffReducer(current.current, summary, { signInOnly });
      if (summary.state === 'signed-in' && (previous.status === 'authorizing' || next.status === 'resuming')) notify();
      if (upgrade && next.status === 'resuming') reportEntitlementRefresh('creative_studio', hookId.current, plansEntryId.current ?? entryId.current, 'success', true);
      if (next.status === 'opening_plan') deadline.current = Date.now() + UPGRADE_TIMEOUT;
      transition(next);
    } catch {
      // Transient read failures do not cancel an otherwise valid browser handoff; the deadline still applies.
    } finally {
      if (polling.current === request) polling.current = null;
    }
  }, [isCurrent, notify, signInOnly, transition, withPlan]);

  // The pricing link is opened by the card's own anchor (a user gesture, so popup blockers allow it).
  // That click starts the upgrade wait; detection then polls the local account like the checkout-return refresh.
  const openPlans = useCallback((planUrl: string) => {
    const status = current.current.status;
    const upgradeFailed = status === 'failed' && (current.current as { phase?: string }).phase === 'upgrade';
    if (!mounted.current || !(status === 'opening_plan' || status === 'idle' || upgradeFailed)) return;
    ++generation.current;
    polling.current = null;
    deadline.current = Date.now() + UPGRADE_TIMEOUT;
    plansEntryId.current = entryId.current;
    attempts.current++;
    transition({ status: 'awaiting_upgrade', planUrl });
  }, [transition]);

  useEffect(() => {
    const login = state.status === 'starting' || state.status === 'authorizing';
    const upgrade = state.status === 'awaiting_upgrade';
    if (!login && !upgrade) return;
    const run = generation.current;
    const timer = window.setTimeout(() => {
      if (!isCurrent(run)) return;
      const status = current.current.status;
      if (login ? status !== 'starting' && status !== 'authorizing' : status !== 'awaiting_upgrade') return;
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
    const resumeKey = key.current;
    let runOnce = resumeRuns.get(resumeKey);
    if (!runOnce) {
      // Reserved before the callback runs (Strict Mode, remounts). It still runs if this mount goes away first;
      // the workspace's stable requestId keeps a re-send idempotent.
      runOnce = Promise.resolve().then(() => resume.current?.(card, { plan: state.plan, key: resumeKey })).then(() => undefined);
      resumeRuns.set(resumeKey, runOnce);
      runOnce.catch(() => { if (resumeRuns.get(resumeKey) === runOnce) resumeRuns.delete(resumeKey); });
    }
    runOnce.then(() => {
      if (isCurrent(run)) transition({ status: 'done' });
    }, error => {
      // Signed in fine; only the follow-up send failed. Retry re-sends the same continuation.
      if (isCurrent(run)) transition({ status: 'failed', reason: 'continue_failed', message: error instanceof Error ? error.message : undefined });
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

  /** One entry_id per click: the first click reuses the id its exposure was reported with; later clicks get a new one. */
  const beginAttempt = useCallback(() => {
    if (attempts.current++ > 0) {
      entryId.current = newCampaignEntryId();
      setEntryIdState(entryId.current);
    }
    return entryId.current;
  }, []);

  return {
    state, alreadySignedIn, signedInForPlans, entryId: entryIdState, hookId: hookId.current,
    beginAttempt, start, retry: () => start(card), cancel, refresh, openPlans,
  };
}
