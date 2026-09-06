import { themeInitScript } from '@/lib/theme';

/**
 * Ставит класс темы до первой отрисовки — иначе выбравшие тёмную тему
 * видят вспышку светлого фона (docs/05-DESIGN-SYSTEM.md).
 */
export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: themeInitScript() }} />;
}
