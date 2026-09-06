import { listHouses, requireHouse } from '../houses';
import { listUsers } from '../users';

/**
 * Негативная фикстура уровня типов (CLAUDE.md §2).
 *
 * Каждый запрос к данным обязан получать контекст доступа: фильтрация
 * по org_id и house_id живёт в репозиториях, а не в интерфейсе.
 * Если контекст когда-нибудь станет необязательным, `@ts-expect-error`
 * окажется лишним — и `tsc` уронит сборку на этом файле.
 *
 * Файл исключён из обычного прогона ESLint, но входит в проверку типов.
 */

// @ts-expect-error контекст доступа обязателен
export const housesWithoutContext = listHouses();

// @ts-expect-error контекст доступа обязателен
export const usersWithoutContext = listUsers();

// @ts-expect-error контекст доступа обязателен, идентификатор дома сам по себе не годится
export const houseById = requireHouse('00000000-0000-0000-0000-000000000000');
