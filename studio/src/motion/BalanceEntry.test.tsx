// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { studioEvents } from '../../../tracking/events.ts';
import { validProperties } from '../../../tracking/core.ts';
import { Menu } from '../components/ui/Menu';
import { I18nProvider } from '../i18n/I18n';
import { BalanceMenuItem, BalanceRing, formatBalance, planLabel, remainingShare } from './BalanceEntry';
import { trackMotion } from './tracking';

vi.mock('./tracking', () => ({ trackMotion: vi.fn(async () => 'queued') }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.mocked(trackMotion).mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('formats the balance as dollars with two decimals', () => {
  expect(formatBalance('4.8')).toBe('$4.80');
  expect(formatBalance('12.3456')).toBe('$12.35');
  expect(formatBalance('0')).toBe('$0.00');
});

it('measures the credits left against the plan credits, and draws nothing when those are unknown', () => {
  expect(remainingShare('5', '20')).toBe(0.25);
  expect(remainingShare('25', '20')).toBe(1);
  expect(remainingShare('5', null)).toBeNull();
  expect(remainingShare('5', '0')).toBeNull();
  expect(remainingShare(null, '20')).toBeNull();
});

it('draws the credits left as the avatar ring', () => {
  act(() => root.render(<BalanceRing share={0.62} />));
  const paths = container.querySelectorAll('path');
  expect(paths).toHaveLength(2);
  expect(paths[1].getAttribute('stroke-dasharray')).toBe('62 100');
  act(() => root.render(<BalanceRing share={0} />));
  expect(container.querySelectorAll('path')).toHaveLength(1);
});

it('tells how much is left in the account menu and opens Subscription & usage', async () => {
  const openUsage = vi.fn();
  act(() => root.render(<I18nProvider initialLocale="zh-CN"><Menu open trigger={<button type="button">menu</button>}>
    <BalanceMenuItem balance="5" allowance="20" trackingPage="explore" openUsage={openUsage} />
  </Menu></I18nProvider>));
  await act(async () => {});
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent?.includes('可用余额')) as HTMLElement;
  expect(item.textContent).toContain('剩余 $5.00');
  expect(item.querySelector('[style*="width: 25%"]')).not.toBeNull();
  await act(async () => { item.click(); });
  expect(openUsage).toHaveBeenCalledTimes(1);
  const click = vi.mocked(trackMotion).mock.calls.find(([event]) => event === 'ui_click')![1] as Record<string, unknown>;
  expect(click).toMatchObject({ page_name: 'explore', area: 'header', element: 'open_balance' });
  expect(validProperties(studioEvents, 'ui_click', click)).toBe(true);
});

it('names the plan under the account name', () => {
  const t = (message: string, values?: Record<string, string | number>) => ({ 'Free plan': '免费版', '{plan} plan': `${values?.plan} 套餐` })[message] ?? message;
  expect(planLabel('free', t)).toBe('免费版');
  expect(planLabel('plus', t)).toBe('Plus 套餐');
  expect(planLabel('Pro', t)).toBe('Pro 套餐');
});
