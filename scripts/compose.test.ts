import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Сторож compose: свойства, которые ломались молча при первом подъёме
 * на VPS (19–20 сентября 2026, docs/08-DECISIONS.md, I17 и открытые вопросы).
 *
 * Ни одно из них не видно ни тестам приложения, ни сборке: стек поднимается,
 * healthcheck зелёный, а база открыта в интернет с общеизвестным паролем
 * или договор не печатается.
 *
 * Проверяются оба файла, которые читает compose: `docker-compose.yml`
 * и необязательный `docker-compose.override.yml`. Второй не в git, лежит
 * у каждого свой, и он способен вернуть ровно то, что здесь запрещено:
 * заново опубликовать порт, выключить `init`, подставить пароль литералом.
 */
const REPO_ROOT = join(import.meta.dirname, '..');

const BASE_FILE = 'docker-compose.yml';
const OVERRIDE_FILE = 'docker-compose.override.yml';

function read(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

/**
 * Раздел `services:` целиком. Искать сервис по всему файлу нельзя:
 * ключ верхнего уровня `x-что-нибудь:` с вложенным `  postgres:`
 * увёл бы проверки на обманку, а настоящий сервис остался бы без присмотра.
 */
function servicesSection(compose: string): string {
  const lines = compose.split('\n');
  const start = lines.indexOf('services:');

  if (start === -1) {
    return '';
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));

  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Тело сервиса: строки после `  <имя>:` до следующего ключа того же отступа. */
function serviceBlock(compose: string, name: string): string | null {
  const lines = servicesSection(compose).split('\n');
  const start = lines.indexOf(`  ${name}:`);

  if (start === -1) {
    return null;
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,2}\S/.test(line));

  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Элементы списка внутри блока: `      - значение`, кавычки сняты. */
function listItems(block: string): string[] {
  return [...block.matchAll(/^\s+-\s+(.+?)\s*$/gm)].map((match) =>
    (match[1] ?? '').replace(/^['"]|['"]$/g, ''),
  );
}

/**
 * Публикации контейнерного порта 5432, открытые не только на петлевом
 * интерфейсе. `5432:5432` слушает все адреса машины, и ufw его не закрывает:
 * Docker пишет правила iptables в обход него. Суффикс протокола (`/tcp`)
 * отбрасывается: `0.0.0.0:5432:5432/tcp` — та же публикация наружу.
 */
function exposedPostgresPorts(block: string): string[] {
  return listItems(block)
    .map((item) => item.replace(/\/(tcp|udp)$/, ''))
    .filter((mapping) => /(^|:)5432$/.test(mapping) && mapping.includes(':'))
    .filter((mapping) => !mapping.startsWith('127.0.0.1:'));
}

/**
 * `network_mode: host` отменяет публикацию портов вовсе: контейнер слушает
 * прямо на интерфейсах машины, и список `ports` при этом пуст. Запрет
 * на публикацию наружу без этого запрета обходится одной строкой.
 */
function hasHostNetwork(block: string): boolean {
  return /^\s+network_mode:\s*['"]?host['"]?\s*$/m.test(block);
}

/**
 * Значения `POSTGRES_PASSWORD`, не требующие переменной окружения.
 * `${POSTGRES_PASSWORD:-nice}` вернёт общеизвестный пароль базе,
 * опубликованной портом на хост, голая `${POSTGRES_PASSWORD}` — пустой,
 * а литерал `POSTGRES_PASSWORD: nice` не подстановка вовсе.
 * Годится только форма `:?` — она останавливает compose и называет причину.
 */
function weakPasswords(compose: string): string[] {
  const assignments = [...compose.matchAll(/^\s+POSTGRES_PASSWORD:\s*(.+?)\s*$/gm)].map(
    (match) => match[1] ?? '',
  );

  const substitutions = [...compose.matchAll(/\$\{POSTGRES_PASSWORD([^}]*)\}/g)].filter(
    (match) => !(match[1] ?? '').startsWith(':?'),
  );

  // Одно и то же место попадает и в присваивания, и в подстановки:
  // отчёт о нарушениях перечисляет места, а не способы их заметить.
  return [
    ...new Set([
      ...assignments.filter((value) => !/^['"]?\$\{POSTGRES_PASSWORD:\?[^}]*\}['"]?$/.test(value)),
      ...substitutions.map((match) => match[0]),
    ]),
  ];
}

/**
 * PID 1 в контейнере приложения — init, а не node. Процессы chromium,
 * осиротевшие после печати, переходят к PID 1; node их не подбирает,
 * и каждый договор оставлял по четыре зомби до перезапуска контейнера.
 */
function initValue(block: string): string | null {
  return /^\s+init:\s*(\S+)\s*$/m.exec(block)?.[1] ?? null;
}

/**
 * Путь chromium, который compose подставляет приложению, когда в `.env`
 * пусто. Нужна именно форма `:-`: `env_file` передаёт пустое значение
 * как заданное и перекрывает `ENV` образа, а `${X-путь}` пустую строку
 * оставил бы пустой.
 */
function chromiumFallback(block: string): string | null {
  const match = /^\s+CHROMIUM_PATH: ['"]?\$\{CHROMIUM_PATH:-([^}]+)\}['"]?\s*$/m.exec(block);

  return match?.[1] ?? null;
}

function dockerfileChromium(dockerfile: string): string | null {
  return /^ENV CHROMIUM_PATH=(\S+)\s*$/m.exec(dockerfile)?.[1] ?? null;
}

/** Сервисы, которым положена строка подключения из общего якоря. */
const DATABASE_SERVICES = ['migrate', 'app', 'worker'] as const;

/**
 * Строки подключения, записанные в сервисе вручную вместо `*database-url`.
 * Якорь заведён ровно затем, чтобы миграции, приложение и планировщик
 * не разъехались по разным базам; собственная копия строки это отменяет.
 */
function ownDatabaseUrls(compose: string): string[] {
  return DATABASE_SERVICES.flatMap((name) => {
    const block = serviceBlock(compose, name);

    if (block === null) {
      return [];
    }

    return [...block.matchAll(/^\s+DATABASE_URL:\s*(.+?)\s*$/gm)]
      .map((match) => match[1] ?? '')
      .filter((value) => value !== '*database-url')
      .map((value) => `${name}: ${value}`);
  });
}

/**
 * Нарушения, которые одинаково опасны в основном файле и в переопределении.
 * Переопределение обычно молчит о большинстве ключей — молчание нарушением
 * не считается, проверяется только то, что в нём написано.
 */
function violations(compose: string): string[] {
  const found: string[] = [];
  const postgres = serviceBlock(compose, 'postgres');
  const app = serviceBlock(compose, 'app');

  if (postgres !== null) {
    found.push(...exposedPostgresPorts(postgres).map((port) => `postgres опубликован как ${port}`));

    if (hasHostNetwork(postgres)) {
      found.push('postgres вынесен в network_mode: host');
    }
  }

  if (app !== null && initValue(app) === 'false') {
    found.push('у приложения init: false');
  }

  found.push(...weakPasswords(compose).map((value) => `пароль базы без требования: ${value}`));
  found.push(...ownDatabaseUrls(compose).map((value) => `своя строка подключения у ${value}`));

  return found;
}

describe('docker-compose.yml', () => {
  const compose = read(BASE_FILE);

  it('postgres опубликован только на 127.0.0.1', () => {
    const block = serviceBlock(compose, 'postgres');

    expect(block).not.toBeNull();
    expect(exposedPostgresPorts(block ?? '')).toEqual([]);
    expect(hasHostNetwork(block ?? '')).toBe(false);
  });

  it('у пароля базы нет запасного значения', () => {
    expect(compose).toContain('${POSTGRES_PASSWORD:?');
    expect(weakPasswords(compose)).toEqual([]);
  });

  it('строка подключения у всех трёх сервисов из общего якоря', () => {
    expect(compose).toContain('&database-url');
    expect(ownDatabaseUrls(compose)).toEqual([]);

    for (const name of DATABASE_SERVICES) {
      expect(serviceBlock(compose, name)).toContain('DATABASE_URL: *database-url');
    }
  });

  it('приложение получает путь chromium из образа, когда в .env пусто', () => {
    const fromImage = dockerfileChromium(read('Dockerfile'));

    expect(fromImage).not.toBeNull();
    expect(chromiumFallback(serviceBlock(compose, 'app') ?? '')).toBe(fromImage);
  });

  it('у приложения PID 1 — init: зомби chromium подбираются', () => {
    expect(initValue(serviceBlock(compose, 'app') ?? '')).toBe('true');
  });
});

describe('docker-compose.override.yml', () => {
  /*
   * Файла может не быть вовсе: он локальный и не в git. Тогда проверять
   * нечего, но правило обязано существовать заранее — переопределение
   * появляется на машине раньше, чем кто-нибудь вспомнит про этот тест.
   */
  it('не возвращает того, что запрещено в основном файле', () => {
    const path = join(REPO_ROOT, OVERRIDE_FILE);

    expect(existsSync(path) ? violations(read(OVERRIDE_FILE)) : []).toEqual([]);
  });
});

describe('сторож compose ловит нарушения', () => {
  /** Обманка: ключ верхнего уровня с теми же именами сервисов и безопасными значениями. */
  const DECOY = [
    'x-шаблон:',
    '  postgres:',
    '    ports:',
    "      - '127.0.0.1:5432:5432'",
    '  app:',
    '    init: true',
    '',
  ].join('\n');

  function document(...services: string[]): string {
    return `${DECOY}services:\n${services.join('\n')}\n\nvolumes:\n  postgres-data:\n`;
  }

  const SAFE_APP = [
    '  app:',
    '    init: true',
    '    environment:',
    '      DATABASE_URL: *database-url',
  ].join('\n');

  it('публикацию на всех интерфейсах — мимо обманки с тем же именем', () => {
    const compose = document(
      ['  postgres:', '    ports:', "      - '${POSTGRES_PORT:-5432}:5432'"].join('\n'),
      SAFE_APP,
    );

    expect(violations(compose)).toEqual(['postgres опубликован как ${POSTGRES_PORT:-5432}:5432']);
  });

  it('явный 0.0.0.0 с суффиксом протокола', () => {
    const compose = document(
      ['  postgres:', '    ports:', '      - "0.0.0.0:5432:5432/tcp"'].join('\n'),
      SAFE_APP,
    );

    expect(violations(compose)).toEqual(['postgres опубликован как 0.0.0.0:5432:5432']);
  });

  it('подмену публикации на network_mode: host', () => {
    const compose = document(['  postgres:', '    network_mode: host'].join('\n'), SAFE_APP);

    expect(violations(compose)).toEqual(['postgres вынесен в network_mode: host']);
  });

  it('запасной пароль базы', () => {
    const compose = document(
      [
        '  postgres:',
        '    environment:',
        '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-nice}',
      ].join('\n'),
      SAFE_APP,
    );

    expect(violations(compose)).toEqual(['пароль базы без требования: ${POSTGRES_PASSWORD:-nice}']);
  });

  it('пароль литералом, без подстановки вовсе', () => {
    const compose = document(
      ['  postgres:', '    environment:', '      POSTGRES_PASSWORD: nice'].join('\n'),
      SAFE_APP,
    );

    expect(violations(compose)).toEqual(['пароль базы без требования: nice']);
  });

  it('голую подстановку: пароль стал бы пустым', () => {
    const compose = document(
      ['  postgres:', '    environment:', '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}'].join(
        '\n',
      ),
      SAFE_APP,
    );

    expect(violations(compose)).toEqual(['пароль базы без требования: ${POSTGRES_PASSWORD}']);
  });

  it('выключенный init у приложения', () => {
    const compose = document('  app:\n    init: false', '  postgres:\n    ports: []');

    expect(violations(compose)).toEqual(['у приложения init: false']);
  });

  it('собственную строку подключения вместо якоря', () => {
    const compose = document(
      [
        '  app:',
        '    init: true',
        '    environment:',
        '      DATABASE_URL: postgres://a:b@db/x',
      ].join('\n'),
      '  postgres:\n    ports: []',
    );

    expect(violations(compose)).toEqual(['своя строка подключения у app: postgres://a:b@db/x']);
  });

  it('требование пароля формой :? нарушением не считает', () => {
    const compose = document(
      [
        '  postgres:',
        '    environment:',
        '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?задайте пароль}',
      ].join('\n'),
      SAFE_APP,
    );

    expect(violations(compose)).toEqual([]);
  });

  it('переопределение, открывающее порт заново', () => {
    const override = ['services:', '  postgres:', '    ports:', "      - '5432:5432'"].join('\n');

    expect(violations(override)).toEqual(['postgres опубликован как 5432:5432']);
  });
});
