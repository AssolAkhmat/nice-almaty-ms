/**
 * Ограничение частоты входа: 10 попыток за 15 минут на телефон
 * и отдельно на IP (docs/01-ARCHITECTURE.md, решение P1-2).
 */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export const LOGIN_MAX_ATTEMPTS = 10;

export function loginPhoneKey(phone: string): string {
  return `login:phone:${phone}`;
}

export function loginIpKey(ip: string): string {
  return `login:ip:${ip}`;
}

/** Одиннадцатая попытка в окне уже отклоняется. */
export function isOverLimit(count: number, maxAttempts = LOGIN_MAX_ATTEMPTS): boolean {
  return count > maxAttempts;
}

/** Сколько секунд ждать до конца окна. */
export function retryAfterSeconds(
  windowStart: Date,
  moment: Date,
  windowMs = LOGIN_WINDOW_MS,
): number {
  const elapsed = moment.getTime() - windowStart.getTime();

  return Math.max(1, Math.ceil((windowMs - elapsed) / 1000));
}
