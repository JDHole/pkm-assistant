/**
 * `waitForLayoutReady` — zdarzeniowy zamiennik dawnych ślepych zegarów na starcie.
 *
 * Testy przyjechały 1:1 ze strażnika startu, który czytał źródło skasowanego pliku
 * środowiska (clean-room / F2). Tutaj są tym, czym były od początku: BEHAWIORALNYM
 * sprawdzeniem czystej funkcji, która wstaje w gołym Node.
 */
import test from 'ava';
import { waitForLayoutReady } from './layoutReady.js';

// ── T5 (behawioralny — jedyny kawałek, który wstaje bez obsidiana) ──────────
test('layoutReady: brak workspace → resolve od razu', async t => {
    await t.notThrowsAsync(waitForLayoutReady(undefined));
    await t.notThrowsAsync(waitForLayoutReady(null));
    await t.notThrowsAsync(waitForLayoutReady({}));
});

test('layoutReady: workspace wolajacy callback synchronicznie → resolve', async t => {
    let calls = 0;
    const workspace = { onLayoutReady: (cb: () => void) => { calls++; cb(); } };
    await waitForLayoutReady(workspace);
    t.is(calls, 1, 'onLayoutReady ma być wołane dokładnie raz');
});

test('layoutReady: callback po 20 ms → resolve DOPIERO po nim, nie wczesniej', async t => {
    let fired = false;
    const workspace = {
        onLayoutReady: (cb: () => void) => {
            setTimeout(() => { fired = true; cb(); }, 20);
        },
    };
    const started = Date.now();
    await waitForLayoutReady(workspace);
    t.true(fired, 'promise rozwiązał się przed callbackiem — czekanie jest pozorne');
    t.true(Date.now() - started >= 15, 'promise rozwiązał się natychmiast, choć layout nie był gotowy');
});
