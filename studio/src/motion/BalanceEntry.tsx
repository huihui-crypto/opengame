import { type MouseEvent } from 'react';
import { MenuItem } from '../components/ui/Menu';
import { RemixIcon } from '../icons/RemixIcons';
import { useI18n } from '../i18n/I18n';
import type { CreativePage } from './exploreTracking';
import { trackMotion } from './tracking';
import styles from './BalanceEntry.module.css';

const amount = (value: string) => { const number = Number(value); return value.trim() !== '' && Number.isFinite(number) ? number : null; };

/** Shows an OpenDesign balance string as dollars with two decimals; anything that is not a number is shown as given. */
export function formatBalance(balance: string) {
  const value = amount(balance);
  return value === null ? `$${balance}` : `$${value.toFixed(2)}`;
}

/** The plan's display name: `free` becomes the Free plan; other tiers are capitalised, as the account service names them. */
export function planLabel(plan: string, t: (message: string, values?: Record<string, string | number>) => string) {
  const name = plan.trim();
  if (!name || name.toLowerCase() === 'free') return t('Free plan');
  return t('{plan} plan', { plan: name.charAt(0).toUpperCase() + name.slice(1) });
}

/** Share of the plan's credits still available, 0–1; null when the plan's credits are unknown. */
export function remainingShare(balance?: string | null, allowance?: string | null) {
  const left = balance == null ? null : amount(balance), total = allowance == null ? null : amount(allowance);
  if (left === null || total === null || total <= 0) return null;
  return Math.min(1, Math.max(0, left / total));
}

/** A circle round the 30px avatar, clockwise from the top. */
const OUTLINE = 'M15 1.5 A13.5 13.5 0 1 1 14.99 1.5';

/** Remaining plan credits as a ring round the avatar; laid over it, the ring adds no size of its own. */
export function BalanceRing({ share }: { share: number }) {
  const percent = Math.round(share * 100);
  return <svg className={styles.ring} viewBox="0 0 30 30" aria-hidden="true" data-share={percent}>
    <path className={styles.ringTrack} d={OUTLINE} pathLength={100} />
    {percent > 0 && <path className={styles.ringFill} d={OUTLINE} pathLength={100} strokeDasharray={`${percent} 100`} />}
  </svg>;
}

/** Signed-in header avatar: a round initial inside the remaining-credits ring. */
export function AccountAvatar({ initial, share }: { initial?: string; share: number | null }) {
  return <>
    {share !== null && <BalanceRing share={share} />}
    <span className={styles.face}>{initial}</span>
  </>;
}

/** Account menu row: how much is left, with a bar of the plan credits left when those are known. Opens Subscription & usage. */
export function BalanceMenuItem({ balance, allowance, trackingPage, openUsage }: { balance: string; allowance?: string | null; trackingPage?: CreativePage; openUsage: () => void }) {
  const { t } = useI18n();
  const left = formatBalance(balance), share = remainingShare(balance, allowance);
  function open(event: MouseEvent) {
    if (trackingPage) void trackMotion('ui_click', { page_name: trackingPage, area: 'header', element: 'open_balance', interaction_method: event.detail === 0 ? 'keyboard' : 'pointer' });
    openUsage();
  }
  return <MenuItem className={styles.item} onClick={open} aria-label={`${t('Available balance')} · ${t('Remaining')} ${left}`}>
    <span className={styles.row}>
      <span>{t('Available balance')}</span>
      <span className={styles.left}>{t('Remaining')} {left}<RemixIcon name="arrow-right-s-line" size={14} /></span>
    </span>
    {share !== null && <span className={styles.meter} aria-hidden="true"><span className={styles.fill} style={{ width: `${Math.round(share * 100)}%` }} /></span>}
  </MenuItem>;
}
