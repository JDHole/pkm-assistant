/**
 * `utils/banner.ts` nie miał ani jednego testu, choć jego treść ląduje dosłownie
 * w KAŻDYM zbudowanym bundlu. Luka katalogu: „zero testów, zero opisu treści banera".
 *
 * clean-room / F1 (build-release) — napisany przed implementacją (czerwony na stubie),
 * dziś zielony.
 */
import test from 'ava';
import { BANNER_REQUIRED_SUBSTRINGS, buildBanner } from './banner.js';

test('buildBanner: jeden legalny blok komentarza', t => {
    const result = buildBanner({ name: 'pkm-assistant', version: '2.2.0' });

    t.true(result.startsWith('/*'));
    t.true(result.endsWith('*/'));
    // Bez zagnieżdżonego zamknięcia komentarza w środku (poza tym na samym końcu).
    t.false(result.slice(2, -2).includes('*/'));
    t.true(result.includes('2.2.0'));
});

test('buildBanner: deterministyczny, z licencja i copyrightem', t => {
    const pkg = { name: 'pkm-assistant', version: '2.2.0' };
    const a = buildBanner(pkg);
    const b = buildBanner(pkg);

    t.is(a, b, 'dwa wywolania z tym samym argumentem musza dac identyczny string');

    for (const fragment of BANNER_REQUIRED_SUBSTRINGS) {
        t.true(a.includes(fragment), `banner nie zawiera "${fragment}"`);
    }

    t.true(/github\.com/i.test(a), 'banner ma zawierac adres repozytorium');
});
