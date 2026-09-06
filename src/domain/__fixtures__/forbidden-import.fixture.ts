/**
 * Негативная фикстура: расчётное ядро не имеет права знать о базе данных.
 * Проверяется в src/lib/eslint-guards.test.ts.
 */
import { getDb } from '@/db/client';

export const database = getDb;
