/**
 * settingsPersist - reguła "meldunek ze stanu, nie z zamiaru" dla zakładki Ustawienia
 * → Narzędzia (AUD-bledy-028). DOM-u i `Notice` tu nie ma; testujemy samą decyzję.
 */
import test from 'ava';
import { persistOrRollback, applyServerKillSwitch } from './settingsPersist.js';

test('persistOrRollback: udany zapis nie rusza stanu', async t => {
    const cfg = { key: 'nowy' };
    let cofniete = 0;

    const out = await persistOrRollback(async () => {}, () => { cofniete++; cfg.key = 'stary'; });

    t.true(out.saved);
    t.is(out.error, undefined);
    t.is(cofniete, 0);
    t.is(cfg.key, 'nowy');
});

test('persistOrRollback: pad zapisu cofa mutację i oddaje powód (nie rzuca)', async t => {
    const cfg = { key: 'nowy' };
    const bum = new Error('dysk sieciowy odmówił');

    const out = await persistOrRollback(async () => { throw bum; }, () => { cfg.key = 'stary'; });

    t.false(out.saved);
    t.is(out.error, bum);
    t.is(cfg.key, 'stary', 'pamięć wraca do stanu z dysku - UI ma co odrysować');
});

test('kill-switch OFF: serwer jest zamykany NIEZALEŻNIE od zapisu', async t => {
    const kroki: string[] = [];
    const cfg: { enabled?: boolean } = { enabled: true };

    const out = await applyServerKillSwitch({
        enable: false,
        apply: () => { cfg.enabled = false; },
        rollback: () => { cfg.enabled = true; },
        close: async () => { kroki.push('close'); },
        persist: async () => { kroki.push('persist'); throw new Error('dysk odmówił'); },
    });

    t.true(out.closed, 'narzędzia serwera znikają z rejestru mimo padu zapisu');
    t.false(out.saved);
    t.truthy(out.saveError);
    t.deepEqual(kroki, ['close', 'persist'], 'zamknięcie PRZED zapisem, nie po nim');
    t.true(cfg.enabled, 'konfiguracja wraca do stanu z dysku (po restarcie i tak wróci włączona)');
});

test('kill-switch OFF: udany zapis zostawia wyłączenie w pamięci', async t => {
    const cfg: { enabled?: boolean } = { enabled: true };

    const out = await applyServerKillSwitch({
        enable: false,
        apply: () => { cfg.enabled = false; },
        rollback: () => { cfg.enabled = true; },
        close: async () => {},
        persist: async () => {},
    });

    t.true(out.closed);
    t.true(out.saved);
    t.false(cfg.enabled);
});

test('kill-switch OFF: pad zamknięcia nie blokuje zapisu (i wraca jako osobny powód)', async t => {
    const bum = new Error('serwer nie odpowiada');
    const cfg: { enabled?: boolean } = { enabled: true };

    const out = await applyServerKillSwitch({
        enable: false,
        apply: () => { cfg.enabled = false; },
        rollback: () => { cfg.enabled = true; },
        close: async () => { throw bum; },
        persist: async () => {},
    });

    t.false(out.closed);
    t.is(out.closeError, bum);
    t.true(out.saved, 'wyłączenie zostaje zapisane - inaczej po restarcie serwer wróci');
});

test('kill-switch ON: nie zamykamy niczego, a pad zapisu cofa włączenie', async t => {
    const kroki: string[] = [];
    const cfg: { enabled?: boolean } = { enabled: false };

    const out = await applyServerKillSwitch({
        enable: true,
        apply: () => { cfg.enabled = true; },
        rollback: () => { cfg.enabled = false; },
        close: async () => { kroki.push('close'); },
        persist: async () => { throw new Error('dysk odmówił'); },
    });

    t.deepEqual(kroki, [], 'włączanie nie ma czego zamykać');
    t.false(out.closed);
    t.false(out.saved);
    t.false(cfg.enabled);
});
