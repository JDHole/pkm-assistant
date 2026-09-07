/**
 * domainFilter.test.js — filtr domen (E3.3, DEC L13-5c).
 * Pure, bez obsidiana.
 */
import test from 'ava';
import { parseDomainList, checkDomain } from './domainFilter.js';

test('parseDomainList łyka przecinki, średniki i nowe linie', t => {
    t.deepEqual(
        parseDomainList('example.com, evil.pl\n  Foo.COM ;bar.org'),
        ['example.com', 'evil.pl', 'foo.com', 'bar.org']
    );
});

test('parseDomainList sprowadza wklejony URL do samego hosta', t => {
    t.deepEqual(
        parseDomainList('https://user:pass@Sub.Example.com:8443/sciezka?q=1'),
        ['sub.example.com']
    );
    t.deepEqual(parseDomainList('*.example.com'), ['example.com']);
    t.deepEqual(parseDomainList('.example.com.'), ['example.com']);
});

// Junk w tablicy i liczba zamiast tekstu to WEJŚCIE Z DYSKU (`data.json`), nie ścieżka
// z kodu — dlatego typ parametru zostaje uczciwy, a test podaje śmieci przez rzutowanie.
type DomainListArg = Parameters<typeof parseDomainList>[0];

test('parseDomainList: tablica, puste wejścia, duplikaty', t => {
    t.deepEqual(
        parseDomainList(['a.com', ' a.com ', '', null, 'b.com'] as unknown as DomainListArg),
        ['a.com', 'b.com'],
    );
    t.deepEqual(parseDomainList(''), []);
    t.deepEqual(parseDomainList(undefined), []);
    t.deepEqual(parseDomainList(42 as unknown as DomainListArg), []);
});

test('puste listy = filtr wyłączony (zero zmiany zachowania sprzed E3.3)', t => {
    t.is(checkDomain('https://cokolwiek.pl/a', {}), 'allowed');
    t.is(checkDomain('to nie jest URL', {}), 'allowed', 'bez filtra nie parsujemy adresu');
    t.is(checkDomain('https://x.pl', { blockedDomains: [], allowedDomains: [] }), 'allowed');
});

test('blocked łapie domenę i jej subdomeny, ale nie podobne nazwy', t => {
    const ws = { blockedDomains: 'example.com' };
    t.is(checkDomain('https://example.com/artykul', ws), 'blocked');
    t.is(checkDomain('https://sub.example.com/artykul', ws), 'blocked');
    t.is(checkDomain('https://deep.sub.example.com/', ws), 'blocked');
    t.is(checkDomain('https://notexample.com/', ws), 'allowed');
    t.is(checkDomain('https://example.com.evil.pl/', ws), 'allowed', 'sufiks musi być kropkowany od prawej');
});

test('niepusta allowed = whitelista; reszta świata dostaje not_allowed', t => {
    const ws = { allowedDomains: ['wikipedia.org', 'docs.obsidian.md'] };
    t.is(checkDomain('https://pl.wikipedia.org/wiki/X', ws), 'allowed');
    t.is(checkDomain('https://docs.obsidian.md/api', ws), 'allowed');
    t.is(checkDomain('https://example.com/', ws), 'not_allowed');
});

test('blocked ma pierwszeństwo nad allowed', t => {
    const ws = { allowedDomains: ['example.com'], blockedDomains: ['tracker.example.com'] };
    t.is(checkDomain('https://example.com/ok', ws), 'allowed');
    t.is(checkDomain('https://tracker.example.com/pixel', ws), 'blocked');
});

test('przy WŁĄCZONYM filtrze nieparsowalny adres jest odrzucany (fail-closed)', t => {
    const ws = { blockedDomains: ['evil.pl'] };
    t.is(checkDomain('nie-url', ws), 'blocked');
    t.is(checkDomain('', ws), 'blocked');
    t.is(checkDomain(null as unknown as Parameters<typeof checkDomain>[0], ws), 'blocked');
});

test('wielkość liter w hoście nie ma znaczenia', t => {
    t.is(checkDomain('https://EXAMPLE.com/A', { blockedDomains: ['example.com'] }), 'blocked');
});
