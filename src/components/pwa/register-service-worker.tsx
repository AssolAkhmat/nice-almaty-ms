'use client';

import { useEffect } from 'react';

/**
 * Регистрация service worker (docs/07-ROADMAP.md, фаза 6).
 *
 * Без него приложение не устанавливается на телефон и не принимает push.
 * Регистрация идёт после загрузки страницы и молча ничего не делает там,
 * где service worker недоступен: в старом браузере или по обычному http
 * вне localhost.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      return;
    }

    const register = (): void => {
      void navigator.serviceWorker.register('/sw.js');
    };

    if (document.readyState === 'complete') {
      register();

      return;
    }

    window.addEventListener('load', register);

    return () => {
      window.removeEventListener('load', register);
    };
  }, []);

  return null;
}
