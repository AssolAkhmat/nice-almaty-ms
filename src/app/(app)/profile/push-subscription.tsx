'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';

import { subscribePushAction, unsubscribePushAction } from './actions';

export interface PushSubscriptionProps {
  /** Публичный ключ VAPID: без него подписка не оформляется (P6-11). */
  publicKey: string | null;
  /** У человека уже есть живая подписка — возможно, с другого устройства. */
  active: boolean;
}

/** Ключ приходит строкой base64url, а браузер ждёт байты. */
function keyBytes(value: string): ArrayBuffer {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return buffer;
}

function encode(buffer: ArrayBuffer | null): string {
  if (buffer === null) {
    return '';
  }

  let binary = '';

  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Подписка браузера на push (docs/04-MODULES/11-users-settings.md,
 * «Личные настройки»).
 *
 * Подписка живёт в браузере, а не в учётной записи: у одного человека
 * их столько, сколькими устройствами он пользуется. Поэтому включение
 * и отключение делаются здесь, на устройстве, а сервер лишь запоминает
 * выданный браузером адрес.
 */
export function PushSubscription({ active, publicKey }: PushSubscriptionProps) {
  const t = useTranslations('notifications.push');
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const supported =
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;

  const enable = async (): Promise<void> => {
    if (publicKey === null) {
      setMessage(t('notConfigured'));

      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      const permission = await Notification.requestPermission();

      if (permission !== 'granted') {
        setMessage(t('denied'));

        return;
      }

      /*
       * Регистрация service worker живёт в самом приложении, но подписка
       * без него невозможна: если worker ещё не поднялся, ждать его здесь
       * незачем — честнее сказать, что push недоступен.
       */
      const registration =
        (await navigator.serviceWorker.getRegistration()) ??
        (await navigator.serviceWorker.register('/sw.js'));

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      });

      const data = new FormData();
      data.set('endpoint', subscription.endpoint);
      data.set('p256dh', encode(subscription.getKey('p256dh')));
      data.set('auth', encode(subscription.getKey('auth')));
      data.set('userAgent', navigator.userAgent);

      const result = await subscribePushAction(data);

      if (result.error !== undefined) {
        setMessage(t('unavailable'));

        return;
      }

      setMessage(t('enabled'));
      router.refresh();
    } catch {
      setMessage(t('unavailable'));
    } finally {
      setBusy(false);
    }
  };

  const disable = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);

    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();

      if (subscription !== undefined && subscription !== null) {
        const data = new FormData();
        data.set('endpoint', subscription.endpoint);
        await unsubscribePushAction(data);
        await subscription.unsubscribe();
      }

      setMessage(t('disabled'));
      router.refresh();
    } catch {
      setMessage(t('unavailable'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>

      <div className="flex flex-col gap-3">
        <p className="text-text-muted text-[13px]">{t('hint')}</p>

        {publicKey === null ? (
          <p className="text-text-muted text-[13px]" data-testid="push-not-configured">
            {t('notConfigured')}
          </p>
        ) : !supported ? (
          <p className="text-text-muted text-[13px]">{t('unavailable')}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={busy}
              onClick={() => {
                void (active ? disable() : enable());
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              {active ? t('disable') : t('enable')}
            </Button>
            <span className="text-text-muted text-[13px]" data-testid="push-state">
              {active ? t('active') : t('inactive')}
            </span>
          </div>
        )}

        {message !== null && <p className="text-text-muted text-[13px]">{message}</p>}
      </div>
    </Card>
  );
}
