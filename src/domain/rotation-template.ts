import { businessDateToParts, type BusinessDate } from '@/lib/time';

/**
 * Шаблон дня для группы (docs/03-BUSINESS-RULES.md §6.7).
 *
 * `шапка + дата + для каждой ротации дня: зона, чек-лист, имена исполнителей
 * + футер`. Формат — plain text: текст уходит в мессенджер, где разметки нет.
 */
export interface TemplateEntry {
  areaName: string;
  checklistTitle: string;
  /** Имена исполнителей; пусто — зона осталась без назначения. */
  people: readonly string[];
}

export interface DayTemplateInput {
  /** Шапка и футер приходят из настроек дома, каждый — свой у вида уборки. */
  header: string;
  footer: string;
  date: BusinessDate;
  entries: readonly TemplateEntry[];
  /*
   * Подписи для пустого дня и незанятой зоны приходят снаружи: текст уходит
   * людям, а язык дома знает интерфейс, а не расчётное ядро.
   */
  labels: { empty: string; unassigned: string };
}

/** Дата в тексте для людей: день, месяц, год — не формат базы. */
function humanDate(date: BusinessDate): string {
  const { year, month, day } = businessDateToParts(date);

  return `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${String(year)}`;
}

/**
 * Сборка текста дня.
 *
 * Пустые шапка и футер не оставляют пустых строк: текст копируют целиком,
 * и лишний перевод строки в начале сообщения виден сразу. Зона без
 * исполнителя не пропускается — иначе в группе не узнают, что её никто
 * не убирает, а это ровно то, о чём люди должны договориться сами.
 */
export function buildDayTemplate(input: DayTemplateInput): string {
  const lines: string[] = [];

  const head = input.header.trim();
  const dateLine = head === '' ? humanDate(input.date) : `${head} ${humanDate(input.date)}`;

  lines.push(dateLine, '');

  if (input.entries.length === 0) {
    lines.push(input.labels.empty);
  } else {
    for (const entry of input.entries) {
      const people = entry.people.length === 0 ? input.labels.unassigned : entry.people.join(', ');

      lines.push(`${entry.areaName} — ${people}`);
    }
  }

  const foot = input.footer.trim();

  if (foot !== '') {
    lines.push('', foot);
  }

  return lines.join('\n');
}
