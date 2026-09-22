import { useTranslations } from 'next-intl';

/**
 * Ссылки на документ: открыть во вкладке и скачать к себе
 * (указание владельца, 22 сентября 2026).
 *
 * Обе ведут на `/api/v1/files/{id}/view`, а не прямо на содержимое: этот
 * адрес проверяет права и выдаёт пятиминутный пропуск, после чего адрес
 * в строке браузера перестаёт работать. Прямая ссылка на `/content`
 * без пропуска отвергается, поэтому собирать её где-то ещё нельзя —
 * за этим следит `src/components/files/file-links.test.ts`.
 *
 * Открытие идёт первым намеренно: пока единственным способом посмотреть
 * справку было скачивание, медицинские документы жильцов копились
 * в «Загрузках» на личных устройствах админов.
 */
export function fileViewHref(fileId: string, download = false): string {
  return `/api/v1/files/${fileId}/view${download ? '?download=1' : ''}`;
}

export function FileLinks({
  fileId,
  label,
  testId,
}: {
  fileId: string;
  /** Подпись открывающей ссылки; по умолчанию — «Открыть». */
  label?: string;
  testId?: string;
}) {
  const t = useTranslations('files');

  return (
    <span className="flex items-center gap-3 text-[13px]">
      <a
        className="text-accent underline"
        data-testid={testId}
        href={fileViewHref(fileId)}
        rel="noreferrer"
        target="_blank"
      >
        {label ?? t('open')}
      </a>

      <a
        className="text-text-muted hover:text-text underline-offset-2 hover:underline"
        href={fileViewHref(fileId, true)}
        rel="noreferrer"
      >
        {t('download')}
      </a>
    </span>
  );
}
