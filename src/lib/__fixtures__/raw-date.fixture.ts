/**
 * Негативная фикстура: этот файл ОБЯЗАН нарушать запрет на прямое обращение
 * к системным часам. Его линтует src/lib/eslint-guards.test.ts.
 * Из обычного прогона `pnpm lint` каталог исключён.
 */
export const stamp = new Date();

export const millis = Date.now();
