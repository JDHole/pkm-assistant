import test from 'ava';
import {
    normalizeUrl,
    registerKnownUrl,
    registerUrlsFromText,
    isUrlKnown,
    _clearKnownUrls,
    _knownUrlCount,
    MAX_KNOWN_URLS,
} from './urlRegistry.js';

// The registry is a module-level singleton, so run serially and reset between tests.
test.beforeEach(() => _clearKnownUrls());

test.serial('normalizeUrl unifies trailing slash and host case, keeps path/query exact', t => {
    t.is(normalizeUrl('https://Example.com'), normalizeUrl('https://example.com/'));
    t.not(normalizeUrl('https://example.com/a'), normalizeUrl('https://example.com/b'));
    // Query string must be part of the identity (exfil data would live here).
    t.not(normalizeUrl('https://example.com/'), normalizeUrl('https://example.com/?q=secret'));
    t.is(normalizeUrl('   '), null);
    t.is(normalizeUrl(null as unknown as Parameters<typeof normalizeUrl>[0]), null);
});

test.serial('a URL returned by web_search passes; a made-up URL does not', t => {
    // Simulates WebSearchTool registering each result URL.
    const results = [
        { url: 'https://docs.example.com/guide' },
        { url: 'https://news.example.org/article/42' },
    ];
    for (const r of results) registerKnownUrl(r.url);

    t.true(isUrlKnown('https://docs.example.com/guide'));
    t.true(isUrlKnown('https://news.example.org/article/42'));

    // A URL the model invents (classic exfiltration vector) is NOT known → tool refuses.
    t.false(isUrlKnown('https://evil.com/?q=my-private-notes'));
    t.false(isUrlKnown('https://docs.example.com/other-page'));
});

test.serial('knowing one path does NOT unlock another path or query on the same host', t => {
    registerKnownUrl('https://example.com/foo');
    t.true(isUrlKnown('https://example.com/foo'));
    // host-only matching would be a data-exfiltration hole — must stay closed.
    t.false(isUrlKnown('https://example.com/?q=exfiltrated-data'));
    t.false(isUrlKnown('https://example.com/bar'));
});

test.serial('URLs in a user message become known (with trailing punctuation stripped)', t => {
    const count = registerUrlsFromText('Please summarise https://example.com/post and (https://ref.example/x).');
    t.is(count, 2);
    t.true(isUrlKnown('https://example.com/post'));
    t.true(isUrlKnown('https://ref.example/x'));
    // Unrelated URL still unknown.
    t.false(isUrlKnown('https://example.com/unrelated'));
});

test.serial('registerUrlsFromText ignores text without URLs', t => {
    t.is(registerUrlsFromText('no links here'), 0);
    t.is(registerUrlsFromText(''), 0);
    t.is(registerUrlsFromText(null as unknown as Parameters<typeof registerUrlsFromText>[0]), 0);
});

test.serial('trailing-slash equivalence: search result without slash matches read with slash', t => {
    registerKnownUrl('https://example.com');
    t.true(isUrlKnown('https://example.com/'));
    t.true(isUrlKnown('https://example.com'));
});

// Ceiling (risk register 2026-09-02 / S34 z8): the registry is a module-level singleton with
// plugin-runtime lifetime, so without a cap it would grow unbounded (slow memory leak).
// F2.22 (release 2.2.0/W3): imported from the module (above) instead of a local duplicate
// literal that could silently drift from the real cap.

test.serial('registry stays capped at MAX_KNOWN_URLS even when more unique URLs are registered', t => {
    for (let i = 0; i < MAX_KNOWN_URLS + 500; i++) {
        registerKnownUrl(`https://example.com/page-${i}`);
    }
    // B1 (klaster C4b nit): this used to probe only indirectly (newest URL known, no throw) —
    // that also passes with a ceiling that is a no-op (unbounded growth never evicts anything,
    // so the newest URL is trivially known regardless). `_knownUrlCount()` proves the ceiling
    // actually held the registry AT the cap, not past it.
    t.is(_knownUrlCount(), MAX_KNOWN_URLS, 'registering 500 URLs past the cap must not leave the registry bigger than MAX_KNOWN_URLS');
    t.true(isUrlKnown(`https://example.com/page-${MAX_KNOWN_URLS + 499}`));
});

test.serial('exceeding the cap evicts the OLDEST entry first (FIFO over insertion order)', t => {
    registerKnownUrl('https://example.com/oldest');
    for (let i = 0; i < MAX_KNOWN_URLS - 1; i++) {
        registerKnownUrl(`https://example.com/filler-${i}`);
    }
    // Registry is exactly at the cap; the oldest entry ("oldest") is still known.
    t.true(isUrlKnown('https://example.com/oldest'));

    // One more unique URL pushes past the cap — must evict "oldest", not some other entry.
    registerKnownUrl('https://example.com/one-too-many');
    t.true(isUrlKnown('https://example.com/one-too-many'));
    t.true(isUrlKnown('https://example.com/filler-0'), 'a non-oldest filler entry must survive the eviction');
});

test.serial('a URL evicted by the cap becomes unknown again (fail-closed, not fail-open)', t => {
    registerKnownUrl('https://example.com/will-be-evicted');
    for (let i = 0; i < MAX_KNOWN_URLS; i++) {
        registerKnownUrl(`https://example.com/pad-${i}`);
    }
    // Cap exceeded by exactly one unique registration beyond the pre-filled entry — the
    // evicted URL must now be REFUSED by web_read (isUrlKnown === false), not silently
    // trusted just because it once passed provenance.
    t.false(isUrlKnown('https://example.com/will-be-evicted'));
});

test.serial('re-registering an already-known URL does NOT reset its position (no LRU refresh)', t => {
    registerKnownUrl('https://example.com/reused');
    for (let i = 0; i < MAX_KNOWN_URLS - 1; i++) {
        registerKnownUrl(`https://example.com/filler2-${i}`);
    }
    // Registry is at the cap. Re-registering the already-known URL is a no-op for
    // `Set` insertion order (documented FIFO-not-LRU trade-off) — it stays known here
    // only because the registry has not exceeded its cap yet.
    registerKnownUrl('https://example.com/reused');
    t.true(isUrlKnown('https://example.com/reused'));

    // Pushing one NEW unique URL past the cap must still evict "reused" first (it was
    // never moved to the back), proving re-registration did not refresh it.
    registerKnownUrl('https://example.com/pushes-past-cap');
    t.false(isUrlKnown('https://example.com/reused'), 're-registering a known URL must not protect it from FIFO eviction');
});
