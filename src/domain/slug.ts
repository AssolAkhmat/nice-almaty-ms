/**
 * Слаг дома участвует в пути хранения документов
 * (`/{house_slug}/{residency_id}/{document_type}/`, docs/01-ARCHITECTURE.md),
 * поэтому обязан быть латиницей без пробелов и служебных символов.
 *
 * Чистая функция: ни БД, ни времени.
 */
const TRANSLITERATION: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ә: 'a',
  ғ: 'g',
  қ: 'q',
  ң: 'n',
  ө: 'o',
  ұ: 'u',
  ү: 'u',
  һ: 'h',
  і: 'i',
};

const MAX_LENGTH = 60;

/**
 * Приводит название к слагу. Пустой результат — ошибка: молча выдать
 * пустой путь хранения нельзя.
 */
export function slugify(name: string): string {
  const transliterated = [...name.toLowerCase()]
    .map((char) => TRANSLITERATION[char] ?? char)
    .join('');

  const slug = transliterated
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/g, '');

  if (slug === '') {
    throw new RangeError(`Из названия «${name}» не получается слаг`);
  }

  return slug;
}

/** Слаг, свободный среди занятых: к повторам добавляется числовой хвост. */
export function uniqueSlug(name: string, taken: ReadonlySet<string>): string {
  const base = slugify(name);

  if (!taken.has(base)) {
    return base;
  }

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  throw new RangeError(`Свободный слаг для «${name}» не найден`);
}
