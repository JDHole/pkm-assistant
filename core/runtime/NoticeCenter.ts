/**
 * `NoticeCenter` — powiadomienia runtime'u.
 *
 * S-17 REGUŁA: gałąź ustawień powiadomień jest PROWIZJONOWANA w SUROWYM worku
 * (`settingsStore.raw`), ale getter zwraca gałąź Z PROXY — wyciszenie przez usera
 * to prawdziwa decyzja i MA planować zapis. Boot sam z siebie nie planuje zapisu.
 */
import { t } from '../i18n/index.js';
import { log as globalLog } from '../utils/Logger.js';
import { hostWindow } from '../utils/hostWindow.js';
import { NOTICE_ACTIONS_CSS_CLASS, NOTICE_DEFAULT_TIMEOUT_MS } from './contracts.js';
import type {
    LoggerLike,
    NoticeAction,
    NoticeHandle,
    NoticeLike,
    NoticeOptions,
    NoticesSettingsSlice,
} from './contracts.js';
import type { SettingsStore } from './SettingsStore.js';

const SCOPE = 'NoticeCenter';

/** Znak guzika „wycisz" — i18n nie ma osobnego klucza na etykietę, tylko na potwierdzenie. */
const MUTE_GLYPH = '\u{1F515}';

/** Fabryka natywnego powiadomienia — DI, żeby klasa dała się testować bez Obsidiana. */
export type CreateNoticeFn = (
    content: string | DocumentFragment,
    timeout: number,
) => NoticeHandle & { containerEl?: HTMLElement };

export interface NoticeCenterDeps {
    createNotice: CreateNoticeFn;
    settingsStore: SettingsStore;
    log?: LoggerLike;
}

/** Luźny widok worka — ustawienia przyjeżdżają z dysku jako `unknown`. */
type Worek = Record<string, unknown>;

/** Opcje elementu w pomocniczych Obsidiana (`cls`, `text`). */
interface OpcjeElementu { text?: string; cls?: string }

/** Element/fragment widziany przez pomocnicze Obsidiana — tyle, ile buduje powiadomienie. */
interface WezelObsidiana {
    createDiv(opts?: OpcjeElementu): WezelObsidiana;
    createEl(tag: string, opts?: OpcjeElementu): HTMLElement;
}

/**
 * `createFragment` jest globalną pomocniczą okna renderera Obsidiana (harness ją dokłada);
 * poza nimi nie istnieje i wtedy treść schodzi do tekstu.
 */
interface GlobaleObsidiana {
    createFragment?: (cb: (fragment: DocumentFragment & WezelObsidiana) => void) => DocumentFragment;
}

export class NoticeCenter implements NoticeLike {
    // `declare` = sama deklaracja typu, zero emitu (kontrakt kampanii TS).
    declare private _createNotice: CreateNoticeFn;
    declare private _store: SettingsStore;
    declare private _log: LoggerLike;
    declare private _zywe: Set<NoticeHandle>;

    constructor(deps: NoticeCenterDeps) {
        this._createNotice = deps.createNotice;
        this._store = deps.settingsStore;
        this._log = deps.log ?? globalLog;
        this._zywe = new Set();
    }

    /**
     * Pokazuje powiadomienie. Wyciszone id (N-02) nie dociera na ekran — zwracany jest `null`,
     * więc wołacz nie ma czego zamykać i po niczym nie sprząta.
     */
    show(text: string, options: NoticeOptions = {}): NoticeHandle | null {
        const id = options.id;
        if (id && this.isMuted(id)) return null;

        const timeout = options.timeout ?? NOTICE_DEFAULT_TIMEOUT_MS;
        const akcje: NoticeAction[] = [...(options.actions ?? [])];
        if (options.mutable && id) {
            akcje.push({ label: MUTE_GLYPH, onClick: () => { this.mute(id); } });
        }

        let surowy: NoticeHandle & { containerEl?: HTMLElement };
        try {
            surowy = this._createNotice(this._zbudujTresc(text, akcje), timeout);
        } catch (e) {
            this._log.error(SCOPE, 'nie udało się pokazać powiadomienia:', e);
            return null;
        }
        if (!surowy) return null;

        const uchwyt: NoticeHandle = {
            hide: () => {
                this._zywe.delete(uchwyt);
                try {
                    surowy.hide();
                } catch (e) {
                    this._log.error(SCOPE, 'zamknięcie powiadomienia padło:', e);
                }
            },
        };
        this._zywe.add(uchwyt);
        return uchwyt;
    }

    /** Czy dany id jest wyciszony (`pkmAssistant.notices.muted`). */
    isMuted(id: string): boolean {
        // Czytamy SUROWYM workiem: odczyt niczego nie prowizjonuje i nie planuje zapisu.
        const pkm: Worek | undefined = this._store.raw['pkmAssistant'];
        const galaz = pkm?.['notices'] as NoticesSettingsSlice | undefined;
        return galaz?.muted?.[id] === true;
    }

    /** Wycisza id — mutacja PRZEZ PROXY (S-17), więc planuje zapis. */
    mute(id: string): void {
        if (!id) return;
        // Kontenery dotwarzamy w SUROWYM worku (samo ich istnienie nie jest decyzją usera),
        // a samą flagę stawiamy przez proxy — bo to JEST decyzja i ma dojechać na dysk.
        this._kontenerMuted();
        const galaz = (this._store.settings['pkmAssistant'] as Worek)['notices'] as NoticesSettingsSlice;
        const muted = galaz.muted as Record<string, boolean>;
        muted[id] = true;
        this.show(t('env.notice_muted'));
    }

    /** N-01: zamyka wszystkie żywe powiadomienia i zdejmuje nasłuchy. */
    unload(): void {
        for (const uchwyt of [...this._zywe]) {
            try {
                uchwyt.hide();
            } catch (e) {
                this._log.error(SCOPE, 'zamknięcie powiadomienia przy demontażu padło:', e);
            }
        }
        this._zywe.clear();
    }

    /** Prowizjonowanie gałęzi `pkmAssistant.notices.muted` w SUROWYM worku (S-17). */
    private _kontenerMuted(): Record<string, boolean> {
        const raw = this._store.raw as Worek;
        const pkm = (raw['pkmAssistant'] ??= {}) as Worek;
        const notices = (pkm['notices'] ??= {}) as NoticesSettingsSlice;
        return (notices.muted ??= {});
    }

    /**
     * Treść powiadomienia. Z guzikami akcji potrzebny jest DOM — poza nim (goły Node:
     * testy jednostkowe) schodzimy do postaci tekstowej, bo i tak nie ma czego kliknąć.
     *
     * Budujemy przez GLOBALNE pomocnicze Obsidiana (`createFragment`), nie przez
     * `document.createDocumentFragment()` — tego wymaga walidator katalogu wtyczek,
     * a harness dokłada te same globale, więc ta gałąź jest tam żywa.
     */
    private _zbudujTresc(text: string, akcje: NoticeAction[]): string | DocumentFragment {
        if (akcje.length === 0) return text;

        const zbuduj = (hostWindow as unknown as GlobaleObsidiana).createFragment;
        if (typeof zbuduj !== 'function') {
            const etykiety = akcje.map(a => a.label).join(' ');
            return `${text} <span class="${NOTICE_ACTIONS_CSS_CLASS}">${etykiety}</span>`;
        }

        return zbuduj(fragment => {
            fragment.createDiv({ text });
            const rzad = fragment.createDiv({ cls: NOTICE_ACTIONS_CSS_CLASS });
            for (const akcja of akcje) {
                const guzik = rzad.createEl('button', { text: akcja.label });
                guzik.addEventListener('click', () => {
                    try {
                        akcja.onClick();
                    } catch (e) {
                        this._log.error(SCOPE, 'akcja powiadomienia rzuciła:', e);
                    }
                });
            }
        });
    }
}
