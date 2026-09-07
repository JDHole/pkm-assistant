import test from 'ava';
import { setLocale } from '../../core/i18n/index.js';
import { buildSkillIndex } from './skillIndex.js';

setLocale('pl');

const skill = (over = {}) => ({
    name: 'daily-review',
    description: 'przegląd dnia',
    path: '.pkm-assistant/skills/daily-review/SKILL.md',
    icon: '📋',
    ...over,
});

test('pusta lista skilli → pusty string', t => {
    t.is(buildSkillIndex([]), '');
    t.is(buildSkillIndex(), '');
});

test('skill model-invocable renderuje nazwę, opis i ścieżkę read()', t => {
    const out = buildSkillIndex([skill()]);
    t.true(out.includes('daily-review'));
    t.true(out.includes('przegląd dnia'));
    t.true(out.includes('read(".pkm-assistant/skills/daily-review/SKILL.md")'));
    t.true(out.includes('📋'));
});

test('skill bez ścieżki → brak sufiksu read() (bez wybuchu)', t => {
    const out = buildSkillIndex([skill({ path: undefined })]);
    t.true(out.includes('daily-review'));
    t.false(out.includes('read('));
});

test('skille manual-only lądują na osobnej liście, nie w indeksie read()', t => {
    const out = buildSkillIndex([
        skill({ name: 'daily-review' }),
        skill({ name: 'create-skill', disableModelInvocation: true, path: '.pkm-assistant/skills/create-skill/SKILL.md' }),
    ]);
    // create-skill nie ma linii z read() (jest manual-only)
    t.false(out.includes('read(".pkm-assistant/skills/create-skill/SKILL.md")'));
    // ale jego nazwa jest wymieniona na liście manualnej
    t.true(out.includes('create-skill'));
    t.true(out.includes('daily-review'));
});

test('BUDŻET: nadmiarowe skille wypadają + linia „…i N kolejnych"', t => {
    const many = Array.from({ length: 10 }, (_, i) => skill({ name: `skill-${i}`, path: `.pkm-assistant/skills/skill-${i}/SKILL.md` }));
    // Bardzo mały budżet → tylko jeden skill zmieści się (zawsze ≥1), reszta jako „…i N kolejnych".
    const out = buildSkillIndex(many, 120);
    t.true(out.includes('skill-0'));
    t.false(out.includes('skill-9'));
    t.regex(out, /kolejnych/);
    t.true(out.includes('list(".pkm-assistant/skills")'));
});

test('BUDŻET: wszystko się mieści → brak linii „…i N kolejnych"', t => {
    const out = buildSkillIndex([skill(), skill({ name: 'weekly-review', path: '.pkm-assistant/skills/weekly-review/SKILL.md' })]);
    t.notRegex(out, /kolejnych/);
});
