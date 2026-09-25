import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/**
 * Докладчик приёмок для CI: все причины в одной заметке.
 *
 * Штатный докладчик `github` заводит отдельную заметку на каждую упавшую
 * проверку и ещё по одной на каждую попытку. GitHub показывает не больше
 * десяти заметок на прогон, поэтому при одиннадцати падениях пятое и дальше
 * не видны вовсе: снаружи прогон выглядел как «упало одиннадцать», а чинить
 * можно было только четыре — остальные приходилось угадывать.
 *
 * Здесь заметка одна, и в ней список: ширина, проверка, первая строка отказа.
 * Одиннадцать причин помещаются; сто — обрежутся с явной пометкой, а не молча.
 *
 * Правило увиденного отказа (CLAUDE.md §2): падение, которого не видно,
 * не считается увиденным.
 */
const MAX_FAILURES = 60;

/**
 * Длина причины. GitHub обрезает слишком длинную заметку целиком, и одна
 * причина со списком из тридцати идентификаторов съедала остальные пять.
 */
const MAX_CAUSE = 240;

interface Failure {
  cause: string;
  title: string;
}

/** Первая содержательная строка ошибки: она называет причину. */
function causeOf(result: TestResult): string {
  const message = result.error?.message ?? result.errors[0]?.message ?? '';

  /* Цветовые последовательности терминала в заметке не нужны. */
  // eslint-disable-next-line no-control-regex -- строка отчёта приходит с цветом
  const withoutColour = message.replaceAll(/\u001B\[[\d;]*m/gu, '');

  const lines = withoutColour
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const first = lines[0] ?? 'причина не названа';

  return first.length > MAX_CAUSE ? `${first.slice(0, MAX_CAUSE)}…` : first;
}

/** GitHub принимает многострочную заметку только с экранированными переводами. */
function escape(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

export default class CompactCiReporter implements Reporter {
  private readonly failures: Failure[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'passed' || result.status === 'skipped') {
      return;
    }

    /* Последняя попытка — итог проверки; промежуточные повторы не множим. */
    if (result.retry < test.retries) {
      return;
    }

    this.failures.push({
      cause: causeOf(result),
      title: `${test.titlePath().slice(1).join(' › ')}`,
    });
  }

  onEnd(): void {
    if (this.failures.length === 0) {
      return;
    }

    const shown = this.failures.slice(0, MAX_FAILURES);
    const lines = shown.map((failure) => `• ${failure.title}\n    ${failure.cause}`);

    if (this.failures.length > shown.length) {
      lines.push(`… и ещё ${String(this.failures.length - shown.length)} — смотрите отчёт`);
    }

    const body = [`Упало проверок: ${String(this.failures.length)}`, ...lines].join('\n');

    process.stdout.write(`::error title=Приёмки::${escape(body)}\n`);
  }
}
