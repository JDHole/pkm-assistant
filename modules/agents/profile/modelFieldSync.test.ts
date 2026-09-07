/**
 * B6 druga runda (2026-09-02) — model.main jest kanonem, legacy `model` się nie odradza.
 *
 * Koordynator znalazł ŻYWĄ ścieżkę, której pierwsza runda B6 nie objęła: `AgentProfileView.ts`
 * budował `formData` blokiem „Sync model ↔ models.main", który KOPIOWAŁ `models.main` do
 * `formData.model` (legacy pole) przy KAŻDYM otwarciu/renderze profilu — a `profile_advanced.ts`
 * zapisuje `updates.model = formData.model || null` przy KAŻDYM „Zapisz profil" (dowolna
 * zakładka). U Kuby wszyscy agenci mają ten sam `models.main` (LM Studio) → „ta sama twarda
 * wartość model: u wszystkich agentów" — dokładnie objaw Niki.
 *
 * Pierwszy test niżej reprodukuje STARY algorytm (kopia diagnostyczna, nie kod produkcyjny) i
 * dowodzi, że jest CZERWONY — po czym pokazuje, że `resolveMainModelForForm` na tym samym
 * wejściu jest ZIELONY.
 */
import test from 'ava';
import { Agent } from '../Agent.js';
import { AgentLoader } from '../AgentLoader.js';
import { parseYaml } from '../../../core/utils/yamlParser.js';
import { resolveMainModelForForm, applyMainModelChange } from './modelFieldSync.js';

// ── (a) models.main bez model: stary algorytm dopisywał model:, nowy — nie ────────────────

test('B6-2 repro: KOPIA starego "Sync model ↔ models.main" dopisuje model: mimo braku edycji usera (CZERWONY dowód diagnozy)', t => {
    /**
     * Bajt-w-bajt kopia bloku sprzed tej naprawy (`AgentProfileView.ts`, przed B6 druga runda).
     * Zostaje tu WYŁĄCZNIE jako dowód diagnozy — nie jest wołana z kodu produkcyjnego.
     */
    function legacySync(formData: { model: string | null; models: Record<string, unknown> }) {
        if ((formData.models as { main?: unknown })?.main) {
            const m = (formData.models as { main: unknown }).main;
            formData.model = typeof m === 'string' ? m : ((m as { platform?: string; model?: string })?.platform && (m as { model?: string })?.model
                ? `${(m as { platform: string }).platform}/${(m as { model: string }).model}`
                : formData.model);
            (formData.models as Record<string, unknown>).main = formData.model || undefined;
        } else if (formData.model) {
            if (!formData.models) formData.models = {};
            (formData.models as Record<string, unknown>).main = formData.model;
        }
        return formData;
    }

    const legacyFormData = legacySync({ model: null, models: { main: 'lm_studio/local-model' } });
    const legacyAgent = new Agent({ name: 'Klara' });
    legacyAgent.update({ model: legacyFormData.model, models: legacyFormData.models });
    const legacyData = legacyAgent.serialize();
    t.is(legacyData.model, 'lm_studio/local-model', 'DOWÓD: stary algorytm pisze model: do yamla mimo że user nic nie zmienił w selekcie');

    // Ten sam wypadek przez NOWY helper:
    const fixed = resolveMainModelForForm({ model: null, models: { main: 'lm_studio/local-model' } });
    const agent = new Agent({ name: 'Klara' });
    agent.update({ model: fixed.model, models: fixed.models });
    const data = agent.serialize();
    t.false('model' in data, 'po naprawie: odczyt/zapis profilu bez zmiany modelu nie dopisuje model:');
    t.deepEqual(data.models, { main: 'lm_studio/local-model' }, 'models.main zostaje nietknięty (kanon)');
});

// ── review Opusa p.3: agent z OBOMA polami naraz (resztki starego buga rundy 2) musi się
// doczyścić — legacy `model` gaśnie bezwarunkowo, nie jest konserwowany. ─────────────────

test('B6-2 (p.3): agent z OBOMA polami ustawionymi (resztki starego buga) — legacy model gaśnie, nie jest konserwowany', t => {
    const fixed = resolveMainModelForForm({ model: 'lm_studio/local-model', models: { main: 'lm_studio/local-model' } });
    t.is(fixed.model, null, 'legacy pole gaśnie bezwarunkowo — nawet gdy niosło tę samą wartość co models.main');
    t.deepEqual(fixed.models, { main: 'lm_studio/local-model' });

    const agent = new Agent({ name: 'Klara', model: 'lm_studio/local-model', models: { main: 'lm_studio/local-model' } });
    agent.update({ model: fixed.model, models: fixed.models });
    const data = agent.serialize();
    t.false('model' in data, 'po JEDNYM zapisie profilu yaml jest w końcu doczyszczony z legacy model:');
    t.deepEqual(data.models, { main: 'lm_studio/local-model' });
});

test('B6-2 (p.3): agent z OBOMA polami o RÓŻNYCH wartościach — models.main (kanon) wygrywa, legacy przepada bez śladu', t => {
    // Skrajny przypadek: user ręcznie edytował yaml i models.main NIE zgadza się z legacy model.
    // Kanon rozstrzyga jednoznacznie — nic nie miesza obu wartości.
    const fixed = resolveMainModelForForm({ model: 'openai/gpt-4o-STARY', models: { main: 'anthropic/claude-sonnet-4-5' } });
    t.is(fixed.selectValue, 'anthropic/claude-sonnet-4-5');
    t.is(fixed.model, null);
    t.deepEqual(fixed.models, { main: 'anthropic/claude-sonnet-4-5' });
});

// ── (b) legacy `model` bez models.main: jednorazowa migracja, model gaśnie ────────────────

test('B6-2: sam legacy model (bez models.main) — jednorazowa migracja: models.main = wartość, model = null', t => {
    const fixed = resolveMainModelForForm({ model: 'openai/gpt-4o', models: {} });
    t.is(fixed.selectValue, 'openai/gpt-4o');
    t.is(fixed.model, null, 'legacy pole gaśnie w formData zaraz po migracji');
    t.deepEqual(fixed.models, { main: 'openai/gpt-4o' });

    const agent = new Agent({ name: 'Tola', model: 'openai/gpt-4o' });
    agent.update({ model: fixed.model, models: fixed.models });
    const data = agent.serialize();
    t.false('model' in data, 'po zapisie legacy pole zniknęło z yamla');
    t.deepEqual(data.models, { main: 'openai/gpt-4o' }, 'wartość przetrwała — awansowała na kanon');
});

// ── (c) zmiana selecta: pisze TYLKO models.main ────────────────────────────────────────────

test('B6-2: applyMainModelChange — wybór modelu w selekcie pisze TYLKO models.main, model zostaje null', t => {
    const result = applyMainModelChange({}, 'anthropic/claude-sonnet-4-20250514');
    t.is(result.model, null);
    t.deepEqual(result.models, { main: 'anthropic/claude-sonnet-4-20250514' });

    const agent = new Agent({ name: 'Borys' });
    agent.update({ model: result.model, models: result.models });
    const data = agent.serialize();
    t.false('model' in data, 'świadoma zmiana modelu w UI nie odradza legacy pola');
    t.deepEqual(data.models, { main: 'anthropic/claude-sonnet-4-20250514' });
});

// ── (d) wyczyszczenie selecta: brak obu ────────────────────────────────────────────────────

test('B6-2: applyMainModelChange — wyczyszczenie selecta usuwa oba pola (brak model:, brak models: resztek)', t => {
    const result = applyMainModelChange({ main: 'openai/gpt-4o' }, '');
    t.is(result.model, null);
    t.false('main' in result.models, 'klucz main USUNIĘTY (nie main:undefined) — inaczej Object.keys(models).length>0 zostawia models:{}');

    const agent = new Agent({ name: 'Igor', models: { main: 'openai/gpt-4o' } });
    agent.update({ model: result.model, models: result.models });
    const data = agent.serialize();
    t.false('model' in data);
    t.false('models' in data, 'models pusty po wyczyszczeniu — zero osieroconego models: {}');
});

// ── Skrajne wejścia i normalizacja formy obiektowej ────────────────────────────────────────

test('B6-2: resolveMainModelForForm — nic nie ustawione, nic do migrowania', t => {
    const fixed = resolveMainModelForForm({});
    t.is(fixed.selectValue, '');
    t.is(fixed.model, null);
    t.deepEqual(fixed.models, {});
});

test('B6-2: resolveMainModelForForm — models.main w formie obiektowej {platform,model} normalizuje się do stringa', t => {
    const fixed = resolveMainModelForForm({ model: null, models: { main: { platform: 'openai', model: 'gpt-4o' } } });
    t.is(fixed.selectValue, 'openai/gpt-4o');
    t.deepEqual(fixed.models, { main: 'openai/gpt-4o' });
});

// ── Round-trip end-to-end: otwarcie profilu (bez edycji modelu) + zapis, na atrapie vaulta ──

/** Vault-atrapa w pamięci (wzór permission_switches.test.ts / agent_yaml_roundtrip.test.ts). */
function makeMemoryVault() {
    const files: Record<string, string> = {};
    return {
        files,
        adapter: {
            async exists(path: string) { return Object.prototype.hasOwnProperty.call(files, path); },
            async mkdir() { /* no-op */ },
            async list(folder: string) {
                return { files: Object.keys(files).filter(f => f.startsWith(`${folder}/`)), folders: [] };
            },
            async read(path: string) { return files[path]; },
            async write(path: string, content: string) { files[path] = content; },
            async remove(path: string) { delete files[path]; },
        },
    };
}

test('B6-2 end-to-end: agent z models.main w yamlu — otwarcie profilu + zapis NIEZWIĄZANEGO pola nie dopisuje model:', async t => {
    const vault = makeMemoryVault();
    vault.files['.pkm-assistant/agents/klara.yaml'] = [
        'name: Klara',
        'disabled_tools: []',
        'models:',
        '  main: lm_studio/local-model',
    ].join('\n');

    const loader = new AgentLoader(vault as never);
    const agent = await loader.loadAgentFromFile('.pkm-assistant/agents/klara.yaml');
    t.is(agent!.model, null, 'punkt wyjścia: legacy model nie był w yamlu');

    // Symulacja AgentProfileView: otwarcie profilu woła resolveMainModelForForm na formData.
    const sync = resolveMainModelForForm({ model: agent!.model, models: agent!.models });
    // Symulacja "Zapisz profil" po edycji CZEGOŚ INNEGO (np. personality na innej zakładce) —
    // dokładnie to, co profile_advanced.handleSave robi z formData po sync.
    agent!.update({ model: sync.model, models: sync.models, personality: 'Energiczna, szybka.' });
    await loader.saveAgent(agent!);

    const rewritten = parseYaml(vault.files['.pkm-assistant/agents/klara.yaml']) as Record<string, unknown>;
    t.false('model' in rewritten, 'DOWÓD naprawy: zapis profilu agenta z models.main nie dopisuje legacy model:');
    t.deepEqual(rewritten.models, { main: 'lm_studio/local-model' }, 'kanon nietknięty');
    t.is(rewritten.personality, 'Energiczna, szybka.', 'niezwiązana edycja normalnie się zapisała');
});
