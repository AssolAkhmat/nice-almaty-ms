import type { SeedOptions } from './seed';

/**
 * Аргументы `pnpm db:seed`.
 *
 * Единственный флаг — `--skeleton`: организация, суперадмин, типы документов,
 * шаблон договора и счета сети, но ни одного дома и ни одного жильца.
 * Он нужен живой сети, где демо-домов быть не должно, а три сущности выше
 * завести неоткуда: экранов у них нет (модули 10 и 11), заводит их только сид.
 *
 * Неизвестный аргумент останавливает сид. Молча проигнорированный флаг —
 * это полный сид там, где просили скелет: пять домов «Дом 1» — «Дом 5»
 * с жильцами появились бы в живой базе от одной опечатки.
 */
const SKELETON = '--skeleton';

export function parseSeedArguments(argv: readonly string[]): SeedOptions {
  const unknown = argv.filter((argument) => argument !== SKELETON);

  if (unknown.length > 0) {
    throw new Error(
      `Сид не знает аргумент ${unknown.join(', ')}. Известен один: ${SKELETON} — ` +
        'сеть без домов и жильцов.',
    );
  }

  return argv.includes(SKELETON) ? { houses: 0, withContent: false } : {};
}
