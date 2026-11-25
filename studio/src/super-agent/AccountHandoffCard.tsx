import { useId } from 'react';
import { Button } from 'open-design-ui/button';
import type { SuperAgentActionCard } from '../../../shared/super-agent';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { useAccountHandoff, type AccountHandoffResume } from './useAccountHandoff';

export function AccountHandoffCard({ card, handoffKey, onResume, onOpenSettings }: {
  card: SuperAgentActionCard;
  /** Unique per chat + turn; gateway card ids repeat across turns and chats. */
  handoffKey?: string;
  onResume?: AccountHandoffResume;
  onOpenSettings?: (card: SuperAgentActionCard, target: 'account' | 'api_key') => void;
}) {
  const { t } = useI18n();
  const descriptionId = useId();
  const { state, alreadySignedIn, start, retry, cancel, refresh } = useAccountHandoff(card, onResume, handoffKey);
  const signIn = card.kind === 'sign_in';
  let title = t(signIn ? 'Sign in with OpenDesign' : 'Upgrade to OpenDesign Plus');
  let description = t(signIn
    ? "Sign in to generate AI images, video, music and voice. I'll continue automatically once you're signed in."
    : card.kind === 'upgrade_go'
      ? "Go plan does not include AI media generation. Upgrade to Plus and I'll continue automatically."
      : "Free plan does not include AI media generation. Upgrade to Plus and I'll continue automatically.");
  let label = t(signIn ? 'Sign in & continue' : 'Upgrade to Plus');
  let action = () => void start(card);
  let secondary: 'cancel' | 'refresh' | 'settings' | undefined;
  let link: string | undefined;
  let disabled = false;

  switch (state.status) {
    case 'idle':
      if (alreadySignedIn) { title = t("You're signed in"); description = ''; label = t('Continue'); }
      else if (!signIn) secondary = 'settings';
      break;
    case 'starting':
      label = t('Opening sign-in…'); disabled = true;
      break;
    case 'authorizing':
      title = t('Finish signing in in your browser');
      description = state.userCode ? t('Verification code: {code}', { code: state.userCode }) : '';
      if (state.browserOpened === false) {
        description = [description, t("Your browser didn't open — use Continue in browser.")].filter(Boolean).join(' ');
      }
      label = ''; link = state.authorizationUrl; secondary = 'cancel';
      break;
    case 'signed_in':
    case 'opening_plan':
      title = t('Signed in. Opening plans…'); description = ''; label = '';
      break;
    case 'awaiting_upgrade':
      title = t('Plans opened in your browser');
      description = t("Upgrade to Plus and I'll continue generating here.");
      label = ''; link = state.planUrl; secondary = 'refresh';
      break;
    case 'resuming':
    case 'done':
      title = t('Signed in — continuing your request'); description = ''; label = '';
      break;
    case 'failed':
      title = t(state.reason === 'timeout' ? 'Sign-in timed out.'
        : state.reason === 'cancelled' ? 'Sign-in was cancelled.'
        : state.reason === 'connector_unavailable' ? "The OpenDesign sign-in component isn't available on this device."
        : state.reason === 'plan_open_failed' ? "Couldn't open your browser."
        : state.reason === 'continue_failed' ? "Signed in, but couldn't continue your request." : 'Sign-in failed.');
      description = state.reason === 'unknown' || state.reason === 'start_failed' || state.reason === 'continue_failed' ? state.message || '' : '';
      label = t('Retry'); action = () => void retry();
      if (state.phase === 'upgrade' && state.reason === 'timeout') {
        title = t("We haven't detected your upgrade yet.");
        description = t("If you've already paid, click Check again; otherwise reopen the plans.");
        label = t('Reopen plans'); secondary = 'refresh';
      }
      if (state.reason === 'connector_unavailable') secondary = 'settings';
      break;
  }

  return (
    <div className="om-sa-action-card" data-kind={card.kind} data-state={state.status} role="group" aria-label={title}>
      <span className="om-sa-action-card-icon" aria-hidden="true">
        <RemixIcon name={state.status === 'done' || state.status === 'resuming' ? 'checkbox-circle-line' : signIn ? 'account-circle-line' : 'sparkling-line'} size={18} />
      </span>
      <div className="om-sa-action-card-copy" aria-live="polite">
        <strong>{title}</strong>
        {description && <p id={descriptionId}>{description}</p>}
      </div>
      {label && (
        <Button
          variant="plain"
          type="button"
          className="om-sa-deliverable-btn om-sa-action-card-btn"
          data-primary
          disabled={disabled}
          aria-describedby={description ? descriptionId : undefined}
          onClick={action}
        >
          {label}
        </Button>
      )}
      {link && (
        <a className="om-sa-deliverable-btn om-sa-action-card-btn" href={link} target="_blank" rel="noreferrer">
          {t('Continue in browser')}
        </a>
      )}
      {secondary === 'cancel' && (
        <Button variant="plain" type="button" className="om-sa-deliverable-btn om-sa-action-card-btn" onClick={() => void cancel()}>
          {t('Cancel')}
        </Button>
      )}
      {secondary === 'refresh' && (
        <Button variant="plain" type="button" className="om-sa-deliverable-btn om-sa-action-card-btn" onClick={() => void refresh()}>
          {t(state.status === 'failed' ? 'Check again' : "I've upgraded")}
        </Button>
      )}
      {secondary === 'settings' && onOpenSettings && (
        <Button variant="plain" type="button" className="om-sa-deliverable-btn om-sa-action-card-btn" onClick={() => onOpenSettings(card, state.status === 'failed' ? 'account' : 'api_key')}>
          {t(state.status === 'failed' ? 'Open account settings' : 'Use my own API key')}
        </Button>
      )}
    </div>
  );
}
