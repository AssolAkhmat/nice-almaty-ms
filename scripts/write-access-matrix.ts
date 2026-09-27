import { writeFileSync } from 'node:fs';

import { renderAccessMatrix } from '../src/lib/access-matrix-doc';

/** Собирает `docs/09-ACCESS-MATRIX.md` из карты доступа. */
writeFileSync('docs/09-ACCESS-MATRIX.md', renderAccessMatrix(), 'utf8');

process.stdout.write('docs/09-ACCESS-MATRIX.md собран из src/lib/access-map.ts\n');
