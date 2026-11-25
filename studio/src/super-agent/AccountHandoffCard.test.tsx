// @vitest-environment happy-dom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSummary } from '../../../shared/provider-directory';
import type { SuperAgentActionCard } from '../../../shared/super-agent';
import { I18nProvider } from '../i18n/I18n';
import { gatewayRequest } from '../motion/gatewayClient';
import { notifyProvidersChanged } from '../motion/useProviderDirectory';
import { AccountHandoffCard } from './AccountHandoffCard';

vi.mock('../motion/gatewayClient', () => ({ gatewayRequest: vi.fn() }));
vi.mock('../motion/useProviderDirectory', () => ({ notifyProvidersChanged: vi.fn() }));
vi.mock('../motion/pageTracking', () => ({ newTrackingId: () => crypto.randomUUID() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card: SuperAgentActionCard = { id: 'signin', kind: 'sign_in', entry: 'agent_media_signed_out', provider: 'account' };
let root: Root;
let container: HTMLDivElement;
let account: AccountSummary;
let loginResult: AccountSummary;
let checkout: { url: string; opened: boolean };
const onResume = vi.fn();
const onOpenSettings = vi.fn();
const request = vi.mocked(gatewayRequest);
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(item => item.textContent === label)!;
const status = () => container.querySelector('.om-sa-action-card')?.getAttribute('data-state');
const click = async (label: string) => { expect(button(label), label).toBeTruthy(); await act(async () => button(label).click()); };
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  account = { state: 'signed-out', consoleUrl: '' };
  loginResult = { state: 'authorizing', consoleUrl: '', authorizationUrl: 'https://example.test/login', userCode: 'ABCD', browserOpened: true };
  checkout = { url: 'https://example.test/dashboard?billing=plan&od_entry_source=test', opened: true };
  onResume.mockReset();
  request.mockReset().mockImplementation(async path => {
    if (path === 'settings/account/login') { account = loginResult; return account; }
    if (path === 'settings/account/subscription') return checkout;
    if (path === 'settings/account/cancel') { account = { state: 'signed-out', consoleUrl: '' }; return account; }
    return account;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function render(target = card, strict = false) {
  await act(async () => {
    const content = <I18nProvider initialLocale="en"><AccountHandoffCard card={target} onResume={onResume} onOpenSettings={onOpenSettings} /></I18nProvider>;
    root.render(strict ? <StrictMode>{content}</StrictMode> : content);
  });
}

describe('AccountHandoffCard', () => {
  it('starts attributed sign-in, shows browser details, and resumes Plus exactly once', async () => {
    await render();
    await click('Sign in & continue');
    expect(request).toHaveBeenCalledWith('settings/account/login', 'POST', { hookId: 'super_agent_signin', entryId: expect.stringMatching(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i) });
    expect(container.textContent).toContain('Verification code: ABCD');
    expect(container.querySelector('a')?.textContent).toBe('Continue in browser');
    expect(container.querySelector('a')?.getAttribute('href')).toBe(loginResult.authorizationUrl);
    account = { ...account, state: 'signed-in', plan: 'plus' };
    await tick(2_000);
    expect(onResume).toHaveBeenCalledExactlyOnceWith(card, { plan: 'plus' });
    expect(notifyProvidersChanged).toHaveBeenCalledTimes(1);
    expect(status()).toBe('done');
    expect(container.querySelector('button')).toBeNull();
    await tick(10_000);
    await act(async () => window.dispatchEvent(new Event('focus')));
    await render({ ...card });
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it.each(['free', 'go'])('opens attributed plans after %s sign-in and resumes on refresh', async plan => {
    await render();
    await click('Sign in & continue');
    account = { ...account, state: 'signed-in', plan };
    await tick(2_000);
    const login = request.mock.calls.find(call => call[0] === 'settings/account/login')!;
    expect(request).toHaveBeenCalledWith('settings/account/subscription', 'POST', { hookId: 'super_agent_upgrade', entryId: (login[2] as { entryId: string }).entryId });
    expect(status()).toBe('awaiting_upgrade');
    expect(onResume).not.toHaveBeenCalled();
    account = { ...account, plan: 'plus' };
    await click("I've upgraded");
    expect(request).toHaveBeenCalledWith('settings/account?refresh=true');
    expect(onResume).toHaveBeenCalledExactlyOnceWith(card, { plan: 'plus' });
  });
  it.each(['upgrade_free', 'upgrade_go'] as const)('opens plans directly for %s without signing in', async kind => {
    const target = { ...card, kind };
    await render(target);
    await click('Use my own API key');
    expect(onOpenSettings).toHaveBeenCalledWith(target);
    await click('Upgrade to Plus');
    expect(status()).toBe('awaiting_upgrade');
    expect(request).not.toHaveBeenCalledWith('settings/account/login', expect.anything(), expect.anything());
    expect(request).toHaveBeenCalledWith('settings/account/subscription', 'POST', { hookId: 'super_agent_upgrade', entryId: expect.any(String) });
    account = { ...account, state: 'signed-in', plan: 'plus' };
    await tick(5_000);
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it('times out sign-in, cancels the connector, and permits retry', async () => {
    await render();
    await click('Sign in & continue');
    await tick(5 * 60_000);
    expect(status()).toBe('failed');
    expect(container.textContent).toContain('Sign-in timed out.');
    expect(request).toHaveBeenCalledWith('settings/account/cancel', 'POST');
    await click('Retry');
    expect(status()).toBe('authorizing');
    expect(onResume).not.toHaveBeenCalled();
  });
  it('checks for payment after checkout times out without cancelling or reopening plans', async () => {
    await render({ ...card, kind: 'upgrade_free' });
    await click('Upgrade to Plus');
    await tick(20 * 60_000);
    expect(status()).toBe('failed');
    expect(container.textContent).toContain("We haven't detected your upgrade yet.");
    expect(container.textContent).toContain("If you've already paid, click Check again; otherwise reopen the plans.");
    expect(button('Reopen plans')).toBeTruthy();
    expect(button('Check again')).toBeTruthy();
    expect(container.textContent).not.toContain('Sign-in timed out.');
    expect(request).not.toHaveBeenCalledWith('settings/account/cancel', 'POST');
    const calls = request.mock.calls.length;
    await click('Check again');
    expect(request.mock.calls.slice(calls)).toEqual([['settings/account?refresh=true']]);
    expect(status()).toBe('failed');
    expect(onResume).not.toHaveBeenCalled();
    account = { ...account, state: 'signed-in', plan: 'plus' };
    await click('Check again');
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(status()).toBe('done');
    expect(request.mock.calls.filter(call => call[0] === 'settings/account/subscription')).toHaveLength(1);
  });
  it.each(['sign_in', 'upgrade_free'] as const)('reopens attributed plans after an upgrade timeout on a %s card', async kind => {
    if (kind === 'sign_in') account = { ...account, state: 'signed-in', plan: 'free' };
    await render({ ...card, kind });
    await click(kind === 'sign_in' ? 'Sign in & continue' : 'Upgrade to Plus');
    const first = request.mock.calls.find(call => call[0] === 'settings/account/subscription')!;
    await tick(20 * 60_000);
    await click('Reopen plans');
    expect(status()).toBe('awaiting_upgrade');
    const requests = request.mock.calls.filter(call => call[0] === 'settings/account/subscription');
    expect(requests).toHaveLength(2);
    expect(requests[1][2]).toMatchObject({ hookId: 'super_agent_upgrade' });
    expect(requests[1][2]).not.toEqual(first[2]);
  });
  it.each(['sign_in', 'upgrade_free', 'upgrade_go'] as const)('retries a rejected continuation from a %s card', async kind => {
    onResume.mockRejectedValueOnce(new Error('Could not continue the conversation. Try again.')).mockResolvedValueOnce(undefined);
    const target = { ...card, kind };
    await render(target);
    await click(kind === 'sign_in' ? 'Sign in & continue' : 'Upgrade to Plus');
    account = { ...account, state: 'signed-in', plan: 'plus' };
    await tick(kind === 'sign_in' ? 2_000 : 5_000);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(status()).toBe('failed');
    expect(container.textContent).toContain('Could not continue the conversation. Try again.');
    await click('Retry');
    expect(onResume).toHaveBeenCalledTimes(2);
    expect(onResume).toHaveBeenLastCalledWith(target, { plan: 'plus' });
    expect(status()).toBe('done');
    await tick(10_000);
    expect(onResume).toHaveBeenCalledTimes(2);
  });
  it.each(['ABCD', undefined])('explains a browser launch failure after verification code %s', async userCode => {
    loginResult = { ...loginResult, userCode, browserOpened: false };
    await render();
    await click('Sign in & continue');
    expect(container.querySelector('.om-sa-action-card-copy p')?.textContent).toBe(
      (userCode ? 'Verification code: ABCD ' : '') + "Your browser didn't open — use Continue in browser.",
    );
    expect(container.querySelector('a')?.getAttribute('href')).toBe(loginResult.authorizationUrl);
    expect(button('Cancel')).toBeTruthy();
  });
  it('marks a stalled plan-opening request as an upgrade timeout', async () => {
    const original = request.getMockImplementation()!;
    request.mockImplementation((...args) => args[0] === 'settings/account/subscription'
      ? new Promise(() => {}) : original(...args));
    await render({ ...card, kind: 'upgrade_free' });
    await click('Upgrade to Plus');
    expect(status()).toBe('opening_plan');
    await tick(20 * 60_000);
    expect(container.textContent).toContain("We haven't detected your upgrade yet.");
    account = { state: 'signed-in', plan: 'plus', consoleUrl: '' };
    await click('Check again');
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(status()).toBe('done');
  });
  it('allows twenty minutes after checkout opens even when opening was slow', async () => {
    const original = request.getMockImplementation()!;
    let openPlans!: (value: typeof checkout) => void;
    request.mockImplementation((...args) => args[0] === 'settings/account/subscription'
      ? new Promise<typeof checkout>(resolve => { openPlans = resolve; }) : original(...args));
    await render({ ...card, kind: 'upgrade_free' });
    await click('Upgrade to Plus');
    await tick(10 * 60_000);
    await act(async () => openPlans(checkout));
    await tick(19 * 60_000);
    expect(status()).toBe('awaiting_upgrade');
    await tick(60_000);
    expect(status()).toBe('failed');
    expect(onResume).not.toHaveBeenCalled();
  });
  it('uses the system-browser fallback and preserves a link when popups are blocked', async () => {
    checkout.opened = false;
    vi.spyOn(window, 'open').mockReturnValue(null);
    await render({ ...card, kind: 'upgrade_go' });
    await click('Upgrade to Plus');
    expect(window.open).toHaveBeenCalledWith(checkout.url, '_blank');
    expect(container.querySelector('a')?.getAttribute('href')).toBe(checkout.url);
    account = { ...account, state: 'signed-in', plan: 'plus' };
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it('clears the fallback popup opener', async () => {
    checkout.opened = false;
    const page = { opener: window };
    vi.spyOn(window, 'open').mockReturnValue(page as Window);
    await render({ ...card, kind: 'upgrade_free' });
    await click('Upgrade to Plus');
    expect(page.opener).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });
  it.each(['sign_in', 'upgrade_free', 'upgrade_go'] as const)('shows the included-plan idle CTA until clicked for restored %s cards', async kind => {
    account = { ...account, state: 'signed-in', plan: 'plus' };
    await render({ ...card, kind });
    expect(container.textContent).toContain("You're signed in");
    expect(onResume).not.toHaveBeenCalled();
    await click('Continue');
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.some(call => call[0].endsWith('/login') || call[0].endsWith('/subscription'))).toBe(false);
  });
  it('cancels authorization and ignores its in-flight poll', async () => {
    await render();
    await click('Sign in & continue');
    let resolve!: (value: AccountSummary) => void;
    request.mockImplementationOnce(() => new Promise<AccountSummary>(done => { resolve = done; }));
    await tick(2_000);
    await click('Cancel');
    await act(async () => resolve({ state: 'signed-in', plan: 'plus', consoleUrl: '' }));
    expect(status()).toBe('idle');
    expect(onResume).not.toHaveBeenCalled();
  });
  it.each([{ plan: 'free' }, { plan: 'go' }])('skips login for an existing signed-in account: %j', async value => {
    account = { ...account, state: 'signed-in', ...value };
    await render();
    await click('Sign in & continue');
    expect(status()).toBe('awaiting_upgrade');
    expect(request.mock.calls.some(call => call[0] === 'settings/account/login')).toBe(false);
    expect(request.mock.calls.filter(call => call[0] === 'settings/account/subscription')).toHaveLength(1);
  });
  it.each([{ plan: 'enterprise' }, { plan: 'free', billingUnavailable: true }])('resumes unknown billing for Agent enforcement: %j', async value => {
    await render();
    await click('Sign in & continue');
    account = { ...account, state: 'signed-in', ...value };
    await tick(2_000);
    expect(onResume).toHaveBeenCalledExactlyOnceWith(card, { plan: value.plan });
    expect(request.mock.calls.some(call => call[0] === 'settings/account/subscription')).toBe(false);
  });
  it('refreshes checkout immediately when the document becomes visible', async () => {
    await render({ ...card, kind: 'upgrade_free' });
    await click('Upgrade to Plus');
    account = { ...account, state: 'signed-in', plan: 'plus' };
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(onResume).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it('waits for a pending cancellation before retrying sign-in', async () => {
    await render();
    await click('Sign in & continue');
    let finishCancel!: (value: AccountSummary) => void;
    request.mockImplementationOnce(() => new Promise<AccountSummary>(resolve => { finishCancel = resolve; }));
    await click('Cancel');
    const calls = request.mock.calls.length;
    await click('Sign in & continue');
    expect(status()).toBe('starting');
    expect(request).toHaveBeenCalledTimes(calls);
    await act(async () => {
      account = { state: 'signed-out', consoleUrl: '' };
      finishCancel(account);
    });
    expect(status()).toBe('authorizing');
    expect(request.mock.calls.filter(call => call[0] === 'settings/account/login')).toHaveLength(2);
  });
  it('shows connector recovery and plan-open failures', async () => {
    loginResult = { state: 'signed-out', consoleUrl: '', errorCode: 'connector_unavailable' };
    await render();
    await click('Sign in & continue');
    await click('Open account settings');
    expect(onOpenSettings).toHaveBeenCalledWith(card);
    account = { ...account, state: 'signed-in', plan: 'free' };
    const original = request.getMockImplementation()!;
    request.mockImplementation((...args) => args[0] === 'settings/account/subscription' ? Promise.reject(new Error('offline')) : original(...args));
    await click('Retry');
    expect(container.textContent).toContain("Couldn't open your browser.");
    request.mockImplementation(original);
    const calls = request.mock.calls.length;
    await click('Retry');
    expect(request.mock.calls.slice(calls)).toEqual([
      ['settings/account/subscription', 'POST', { hookId: 'super_agent_upgrade', entryId: expect.any(String) }],
    ]);
    expect(status()).toBe('awaiting_upgrade');
  });
  it('does not resume twice in Strict Mode', async () => {
    await render(card, true);
    await click('Sign in & continue');
    account = { ...account, state: 'signed-in', plan: 'plus' };
    await tick(2_000);
    await render({ ...card }, true);
    expect(onResume).toHaveBeenCalledTimes(1);
  });
  it('stops polling and ignores late responses after unmount', async () => {
    await render();
    await click('Sign in & continue');
    let resolve!: (value: AccountSummary) => void;
    request.mockImplementationOnce(() => new Promise<AccountSummary>(done => { resolve = done; }));
    await tick(2_000);
    await act(async () => root.unmount());
    const calls = request.mock.calls.length;
    await act(async () => resolve({ state: 'signed-in', plan: 'plus', consoleUrl: '' }));
    await tick(10_000);
    expect(request).toHaveBeenCalledTimes(calls);
    expect(onResume).not.toHaveBeenCalled();
    root = createRoot(container);
  });
});
