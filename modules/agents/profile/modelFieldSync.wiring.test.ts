/**
 * modelFieldSync — strażnik OKABLOWANIA na REALNYM miejscu buga (review Opusa, blocker B6-2 p.4).
 *
 * Dlaczego test po ŹRÓDLE, a nie po zachowaniu: `AgentProfileView.ts` i `profile_advanced.ts`
 * importują `obsidian` (Setting/Notice), więc AVA nie zaimportuje żadnego z nich — to samo
 * ograniczenie opisane w `modules/chat/chat/chat_streaming.limits.test.ts`. Ten plik idzie
 * dokładnie tym wzorem: `fs.readFileSync` + asercje na treści źródła.
 *
 * `modelFieldSync.test.ts` (test „B6-2 repro") niesie KOPIĘ starego algorytmu jako dowód
 * diagnozy — ale to dokumentacja, nie strażnik: kopia i tak zawsze zostanie stara, więc nie
 * łapie regresji, gdyby ktoś PRZYWRÓCIŁ stary sync-blok w prawdziwym `AgentProfileView.ts`.
 * Ten plik pilnuje PRAWDZIWEGO źródła.
 */
import test from 'ava';
import fs from 'node:fs';

const profileViewSource = fs.readFileSync(new URL('../AgentProfileView.ts', import.meta.url), 'utf8');
const advancedSource = fs.readFileSync(new URL('./profile_advanced.ts', import.meta.url), 'utf8');

// ── (a) stary wzór sync ("models.main → formData.model") nie wrócił ───────────────────────

test('B6-2 strażnik (a): AgentProfileView.ts nie kopiuje models.main do formData.model (stary sync-blok nie wrócił)', t => {
    t.false(
        profileViewSource.includes('formData.models.main = formData.model'),
        'ten dokładny wzorzec BYŁ sercem żywego buga — jego powrót znaczy regresję B6-2',
    );
    t.false(
        /formData\.model\s*=\s*typeof m\s*===\s*'string'/.test(profileViewSource),
        'stary algorytm odczytywał models.main i wpisywał go do formData.model — ten kształt nie ma prawa wrócić',
    );
});

// ── (b) AgentProfileView.ts woła resolveMainModelForForm( ─────────────────────────────────

test('B6-2 strażnik (b): AgentProfileView.ts woła resolveMainModelForForm( — helper faktycznie okablowany', t => {
    t.true(
        profileViewSource.includes('resolveMainModelForForm('),
        'sync formData.model/models musi iść przez helper, nie przez ręczny if/else',
    );
    t.true(
        profileViewSource.includes("from './profile/modelFieldSync.js'"),
        'import helpera musi realnie istnieć, nie tylko nazwa wołania w komentarzu',
    );
});

// ── (c) profile_advanced.ts: onChange selecta woła applyMainModelChange( i NIE pisze formData.model = ──

/** Ciało onChange dla selecta „Model główny" — od `v =>` po `renderShard(modelsGrid, ...)` do domykającego `});`. */
function onChangeModeluGlownego(): string {
    const anchor = advancedSource.indexOf("renderShard(modelsGrid, t('profile.advanced.main_model')");
    if (anchor < 0) return '';
    const arrow = advancedSource.indexOf('v =>', anchor);
    if (arrow < 0) return '';
    const koniec = advancedSource.indexOf('}, { options: buildModelOptions', arrow);
    return koniec < 0 ? advancedSource.slice(arrow) : advancedSource.slice(arrow, koniec);
}

test('B6-2 strażnik (c): profile_advanced.ts onChange selecta woła applyMainModelChange( i NIE pisze formData.model =', t => {
    const body = onChangeModeluGlownego();
    t.truthy(body, 'nie znaleziono bloku onChange dla selecta „Model główny" — zmieniła się struktura pliku, popraw ten test');

    t.true(body.includes('applyMainModelChange('), 'onChange musi iść przez helper, nie ręczne pisanie obu pól');
    t.false(
        /formData\.model\s*=/.test(body),
        'onChange NIE MA PRAWA pisać do formData.model — to dokładnie ten wzorzec żywił bug B6-2 (drugi kierunek: selекt → legacy pole → yaml)',
    );
});

test('B6-2 strażnik (c-bis): import applyMainModelChange faktycznie istnieje w profile_advanced.ts', t => {
    t.true(advancedSource.includes("from './modelFieldSync.js'"));
    t.true(advancedSource.includes('applyMainModelChange'));
});
