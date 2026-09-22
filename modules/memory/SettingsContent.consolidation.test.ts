/**
 * SettingsContent.consolidation — render behawioralny podbloku „Konsolidacja pamięci"
 * (dwa wyłączniki auto-konsolidacji + trzy pola liczbowe, dodane wraz z auto-konsolidacją
 * opcjonalną, patrz `consolidationStatus.ts`).
 *
 * `SettingsContent.ts` importuje `obsidian` WYŁĄCZNIE jako typ (`import type { Setting }`,
 * zero emitu) - `Setting` dociera do `renderMemorySection` przez DI (`ctx.Setting`), więc ten
 * test NIE zależy od atrapy `obsidian` z repo harnessu (i dobrze, bo jej `MockControl.onChange()`
 * odrzuca podany callback - nie dałoby się nim sprawdzić ani zapisu do slice'a, ani walidacji).
 * Fake `Setting`/`Control` poniżej SĄ zdolne: pamiętają nazwę, rodzaj kontrolki i handler
 * `onChange`, więc test woła go tak, jak realnie wołałby go Obsidian po wpisaniu wartości.
 *
 * Cała para klas fake jest wstrzyknięta przez granicę `as unknown as MemorySettingsCtx['Setting']`
 * - TypeScript sprawdza `renderMemorySection` wyłącznie względem REALNEGO typu `obsidian.Setting`
 *   (deklaracja `ctx.Setting`), a klasy fake są type-checkowane osobno, względem samych siebie.
 */
import test from 'ava';
import { renderMemorySection } from './SettingsContent.js';
import type { MemoryPkmSlice, MemorySettingsCtx } from './SettingsContent.js';
import { CONSOLIDATION_DEFAULTS } from './consolidationStatus.js';
import { t, setLocale } from '../../core/i18n/index.js';

setLocale('pl');

type ChangeHandler = (value: unknown) => void | Promise<void>;

class FakeControl {
    value: unknown = '';
    onChangeHandler: ChangeHandler | null = null;
    inputEl = { type: '', addClass() { /* no-op */ } };
    setValue(v: unknown) { this.value = v; return this; }
    getValue() { return this.value; }
    setPlaceholder() { return this; }
    setLimits() { return this; }
    onChange(cb: ChangeHandler) { this.onChangeHandler = cb; return this; }
}

interface RecordedSetting {
    name: string;
    isHeading: boolean;
    kind: 'toggle' | 'text' | 'slider' | null;
    control: FakeControl | null;
}

/** Fabryka klasy `Setting` zamknięta nad `registry` - `new Setting(container)` (jeden argument,
 *  dokładnie jak realny Obsidian) dopisuje nowy rekord do TEJ listy. */
function makeSettingClass(registry: RecordedSetting[]) {
    return class FakeSetting {
        rec: RecordedSetting = { name: '', isHeading: false, kind: null, control: null };
        settingEl = { addClass() { /* no-op */ } };
        nameEl = { empty() { /* no-op */ }, appendText() { /* no-op */ } };

        constructor(_container: unknown) {
            registry.push(this.rec);
        }
        setName(n: string) { this.rec.name = n; return this; }
        setDesc(_d: string) { return this; }
        setHeading() { this.rec.isHeading = true; return this; }
        private _addControl(kind: RecordedSetting['kind'], cb: (c: FakeControl) => void) {
            this.rec.kind = kind;
            const control = new FakeControl();
            this.rec.control = control;
            cb(control);
            return this;
        }
        addToggle(cb: (c: FakeControl) => void) { return this._addControl('toggle', cb); }
        addText(cb: (c: FakeControl) => void) { return this._addControl('text', cb); }
        addSlider(cb: (c: FakeControl) => void) { return this._addControl('slider', cb); }
    };
}

function render(pkmOverrides: MemoryPkmSlice = {}): { pkm: MemoryPkmSlice; settings: RecordedSetting[]; saveCallCount: () => number } {
    const settings: RecordedSetting[] = [];
    const pkm: MemoryPkmSlice = { ...pkmOverrides };
    let saveCalls = 0;
    const container = { classList: { add() { /* no-op */ } } } as unknown as HTMLElement;

    const ctx: MemorySettingsCtx = {
        pkm,
        save: () => { saveCalls++; },
        Setting: makeSettingClass(settings) as unknown as MemorySettingsCtx['Setting'],
    };
    renderMemorySection(container, ctx);
    return { pkm, settings, saveCallCount: () => saveCalls };
}

function findByName(settings: RecordedSetting[], key: string): RecordedSetting {
    const name = t(key);
    const found = settings.find(s => s.name === name);
    if (!found) throw new Error(`Setting „${name}" (klucz ${key}) nie istnieje w renderze`);
    return found;
}

test('renderMemorySection: podblok „Konsolidacja pamięci" ma nagłówek + dwa toggle + trzy pola liczbowe', t => {
    const { settings } = render();

    const heading = findByName(settings, 'settings.consolidation_title');
    t.true(heading.isHeading);

    t.is(findByName(settings, 'settings.consolidation_auto_sessions').kind, 'toggle');
    t.is(findByName(settings, 'settings.consolidation_auto_brain').kind, 'toggle');
    t.is(findByName(settings, 'settings.consolidation_session_threshold').kind, 'text');
    t.is(findByName(settings, 'settings.consolidation_brain_limit').kind, 'text');
    t.is(findByName(settings, 'settings.consolidation_batch_size').kind, 'text');
});

test('renderMemorySection: oba toggle startują na false (auto-konsolidacja domyślnie wyłączona)', t => {
    const { settings } = render();
    t.is(findByName(settings, 'settings.consolidation_auto_sessions').control!.getValue(), false);
    t.is(findByName(settings, 'settings.consolidation_auto_brain').control!.getValue(), false);
});

test('renderMemorySection: zmiana toggle „auto sesje" zapisuje pole w slice i woła save()', t => {
    const { pkm, settings, saveCallCount } = render();
    const autoSessions = findByName(settings, 'settings.consolidation_auto_sessions');

    void autoSessions.control!.onChangeHandler?.(true);

    t.is(pkm.memoryV3AutoConsolidateSessions, true, 'zmiana toggle zapisuje pole w slice');
    t.true(saveCallCount() > 0, 'onChange musi wołać save()');
});

test('renderMemorySection: toggle odzwierciedla wartość TRUE już ustawioną w slice', t => {
    const { settings } = render({ memoryV3AutoConsolidateBrain: true });
    t.is(findByName(settings, 'settings.consolidation_auto_brain').control!.getValue(), true);
});

test('renderMemorySection: pole „Próg sesji" - startuje na domyślnej (10), liczba poprawna zapisuje się 1:1', t => {
    const { pkm, settings } = render();
    const field = findByName(settings, 'settings.consolidation_session_threshold');
    t.is(field.control!.getValue(), String(CONSOLIDATION_DEFAULTS.sessionThreshold));

    void field.control!.onChangeHandler?.('25');
    t.is(pkm.memoryV3SessionThreshold, 25);
});

test('renderMemorySection: pole „Limit notatek brain" - niepoprawna liczba wraca do domyślnej (20)', t => {
    const { pkm, settings } = render();
    const field = findByName(settings, 'settings.consolidation_brain_limit');

    void field.control!.onChangeHandler?.('abc');
    t.is(pkm.memoryV3BrainNotesThreshold, CONSOLIDATION_DEFAULTS.brainNotesLimit, 'tekst nie-liczbowy -> domyślna');

    void field.control!.onChangeHandler?.('-5');
    t.is(pkm.memoryV3BrainNotesThreshold, CONSOLIDATION_DEFAULTS.brainNotesLimit, 'liczba <= 0 -> domyślna, nie ujemna');

    void field.control!.onChangeHandler?.('0');
    t.is(pkm.memoryV3BrainNotesThreshold, CONSOLIDATION_DEFAULTS.brainNotesLimit, 'zero -> domyślna (walidacja > 0)');
});

test('renderMemorySection: pole „Rozmiar paczki L1" - liczba poprawna zapisuje się, pusta wraca do domyślnej (5)', t => {
    const { pkm, settings } = render();
    const field = findByName(settings, 'settings.consolidation_batch_size');

    void field.control!.onChangeHandler?.('8');
    t.is(pkm.memoryV3ArchiveBatchSize, 8);

    void field.control!.onChangeHandler?.('');
    t.is(pkm.memoryV3ArchiveBatchSize, CONSOLIDATION_DEFAULTS.batchSize);
});

test('renderMemorySection: pola liczbowe pokazują wartość JUŻ zapisaną w slice, nie zawsze domyślną', t => {
    const { settings } = render({ memoryV3SessionThreshold: 42, memoryV3BrainNotesThreshold: 99, memoryV3ArchiveBatchSize: 3 });

    t.is(findByName(settings, 'settings.consolidation_session_threshold').control!.getValue(), '42');
    t.is(findByName(settings, 'settings.consolidation_brain_limit').control!.getValue(), '99');
    t.is(findByName(settings, 'settings.consolidation_batch_size').control!.getValue(), '3');
});

// ── walidacja liczb: Number()+Number.isInteger, nie parseInt (bug recenzji #9) ─────────────

test('renderMemorySection: „3.7" (ułamek) wraca do domyślnej - parseInt kiedyś cicho ucinał do 3', t => {
    const { pkm, settings } = render();
    void findByName(settings, 'settings.consolidation_session_threshold').control!.onChangeHandler?.('3.7');
    t.is(pkm.memoryV3SessionThreshold, CONSOLIDATION_DEFAULTS.sessionThreshold, 'ułamek nie jest liczbą całkowitą - domyślna, NIE 3');
});

test('renderMemorySection: „1e3" (notacja wykładnicza) zapisuje się jako 1000 - parseInt kiedyś dawał 1', t => {
    const { pkm, settings } = render();
    void findByName(settings, 'settings.consolidation_session_threshold').control!.onChangeHandler?.('1e3');
    t.is(pkm.memoryV3SessionThreshold, 1000, 'Number("1e3") === 1000, poprawnie - NIE 1');
});

test('renderMemorySection: „12abc" (śmieci na końcu) wraca do domyślnej - parseInt kiedyś dawał 12', t => {
    const { pkm, settings } = render();
    void findByName(settings, 'settings.consolidation_batch_size').control!.onChangeHandler?.('12abc');
    t.is(pkm.memoryV3ArchiveBatchSize, CONSOLIDATION_DEFAULTS.batchSize, 'Number("12abc") jest NaN - domyślna, NIE 12');
});

// ── wartość EFEKTYWNA w polu: memoryV3X > legacy archiveX > default (bug recenzji #9) ──────

test('renderMemorySection: bez memoryV3SessionThreshold, ale z legacy archiveSessionThreshold -> pole pokazuje wartość LEGACY, nie domyślną', t => {
    const { settings } = render({ archiveSessionThreshold: 7 });
    t.is(findByName(settings, 'settings.consolidation_session_threshold').control!.getValue(), '7',
        'silnik (resolveConsolidationThresholds) już czyta archiveSessionThreshold jako fallback - pole ma pokazać TĘ wartość, nie 10');
});

test('renderMemorySection: memoryV3SessionThreshold I legacy archiveSessionThreshold naraz -> wygrywa memoryV3X (nowsza nazwa)', t => {
    const { settings } = render({ memoryV3SessionThreshold: 15, archiveSessionThreshold: 7 });
    t.is(findByName(settings, 'settings.consolidation_session_threshold').control!.getValue(), '15');
});

test('renderMemorySection: zapis ZAWSZE ląduje w memoryV3X, nawet gdy pole startowało z wartości legacy', t => {
    const { pkm, settings } = render({ archiveSessionThreshold: 7 });
    void findByName(settings, 'settings.consolidation_session_threshold').control!.onChangeHandler?.('20');
    t.is(pkm.memoryV3SessionThreshold, 20, 'zapis migruje na nową nazwę');
    t.is(pkm.archiveSessionThreshold, 7, 'stare pole zostaje nietknięte (nikt go już nie pisze, ale nie kasujemy cudzej wartości)');
});

test('renderMemorySection: bez memoryV3BrainNotesThreshold, ale z legacy archiveBrainNotesThreshold -> pole pokazuje wartość LEGACY', t => {
    const { settings } = render({ archiveBrainNotesThreshold: 33 });
    t.is(findByName(settings, 'settings.consolidation_brain_limit').control!.getValue(), '33');
});
