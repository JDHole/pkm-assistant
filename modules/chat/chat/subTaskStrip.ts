/**
 * subTaskStrip — pasek biegów sub-agentów POD paskiem zakładek czatu.
 *
 * PO CO: od F2 delegacja domyślnie leci w tle — tura kończy się pokwitowaniem, a sub mieli
 * dalej. Do 2026-08-15 podgląd tych biegów wisiał w globalnym sidebarze; decyzja Kuby:
 * **biegi należą do agenta i sesji**, więc mają być tam, gdzie user je zlecił — w oknie czatu,
 * pod zakładkami. Ten pasek pokazuje wyłącznie biegi AKTYWNEJ zakładki.
 *
 * CZEGO TU NIE MA (świadomie): pola „Wiadomość do suba". Komunikacja z subem należy do
 * agenta, nie do usera — kanał (`registry.postMessage`) żyje dalej i czeka na narzędzie
 * agentowe, ale UI go nie wystawia. User może bieg wyłącznie PRZERWAĆ (Stop).
 *
 * PODZIAŁ ROBOTY: cała arytmetyka (filtr zakładki, kolejność, liczniki, skróty) siedzi
 * w czystym `modules/sub-agents/subTaskPanelModel.ts` (`buildStripModel`). Tutaj jest
 * WYŁĄCZNIE DOM — dlatego plik nie ma własnych testów, a to, co da się policzyć źle
 * po cichu, ma pokrycie w AVA obok modelu.
 *
 * ⚠️ Plik jest CELOWO obsidian-free (zero `import 'obsidian'`) — rysuje strukturalnie
 * typowanym DOM-em, wzorem `SubTaskRunsView`, który go poprzedzał.
 */
import { t } from '../../../core/i18n/index.js';
import { SkinManager, setSvg } from '../../crystal-soul/index.js';
import { buildStripModel, formatDuration } from '../../sub-agents/index.js';
import type { StripRow, StripStep, SubTask, SubTaskStatus } from '../../sub-agents/index.js';

/** Opcje tworzenia elementu — podzbiór obsidianowego `createDiv`/`createEl`, którego używamy. */
interface ElOpts {
    cls?: string;
    text?: string;
    attr?: Record<string, string>;
}

/**
 * Element z obsidianowymi dodatkami. Obsidian dokłada te metody do `HTMLElement` w runtime,
 * ale sam typ mieszka w pakiecie `obsidian`, którego ten plik nie importuje — więc opisujemy
 * STRUKTURALNIE dokładnie tyle, ile pasek dotyka.
 */
type El = HTMLElement & {
    empty(): void;
    createDiv(opts?: ElOpts): El;
    createSpan(opts?: ElOpts): El;
    createEl<K extends keyof HTMLElementTagNameMap>(tag: K, opts?: ElOpts): HTMLElementTagNameMap[K] & El;
};

/** Rejestr biegów w zakresie, jakiego pasek naprawdę używa. */
interface RegistryLike {
    list?(): SubTask[];
    requestStop?(id: string): boolean;
}

/** Skrzynka wyników z tła w zakresie, jakiego pasek używa. */
interface NotifierLike {
    pending?(): SubTask[];
}

interface PluginLike {
    subTaskRegistry?: RegistryLike | null;
    subTaskNotifier?: NotifierLike | null;
}

// AUD-dead-code-231 (2026-09-02): `export` zdjęty — zero referencji spoza tego pliku
// (`renderSubTaskStrip` jest jedynym publicznym wejściem).
interface SubTaskStripContext {
    plugin: PluginLike | null | undefined;
    /** Tożsamość aktywnej zakładki (`chat_tabs._tabKey`) — po niej filtrujemy biegi. */
    tabKey: string;
    /** Agent aktywnej zakładki — dopasowanie awaryjne dla biegów bez adresu zakładki. */
    agentName: string;
    /** Ścieżka aktywnej sesji agenta — twardy wyróżnik „per sesja" (incydent 2026-08-15). */
    sessionPath?: string;
    /** Id rozwiniętego biegu (jeden naraz) albo `null`. Stan trzyma ChatView, nie DOM. */
    expandedId?: string | null;
    /** Klik w chip: `id` = rozwiń, `null` = zwiń. Wołacz zapamiętuje i przerysowuje pasek. */
    onToggle: (id: string | null) => void;
}

/** Kolor kryształu statusu — klasa CSS, nie inline style (lint obsidianmd). */
const STATUS_CLASS: Record<SubTaskStatus, string> = {
    running: 'pkm-substrip__crystal--running',
    done: 'pkm-substrip__crystal--done',
    error: 'pkm-substrip__crystal--error',
    aborted: 'pkm-substrip__crystal--aborted',
};

const STATUS_LABEL_KEY: Record<SubTaskStatus, string> = {
    running: 'chat.substrip.status_running',
    done: 'chat.substrip.status_done',
    error: 'chat.substrip.status_error',
    aborted: 'chat.substrip.status_aborted',
};

/** Rejestr jest fail-soft, ale wysypana atrapa nie ma prawa ubić okna czatu. */
function safeCall<T>(fn: () => T, fallback: T): T {
    try {
        return fn() ?? fallback;
    } catch {
        return fallback;
    }
}

function statusLabel(row: StripRow): string {
    // „Wynik czeka na czat" wygrywa z surowym `done` — dla usera to inny stan
    // („zaraz wpadnie do rozmowy"), nie zwykłe zakończenie.
    if (row.waiting) return t('chat.substrip.status_waiting');
    return t(STATUS_LABEL_KEY[row.status] || 'chat.substrip.status_done');
}

/**
 * Przerysuj pasek w podanym kontenerze.
 *
 * Pusty model = kontener dostaje klasę `pkm-substrip--empty` (zero wysokości), więc czat
 * wygląda dokładnie jak przed tą zmianą, dopóki agent nikogo nie odpali.
 *
 * @returns ile biegów pokazuje pasek (0 = schowany).
 */
export function renderSubTaskStrip(host: El, ctx: SubTaskStripContext): number {
    host.empty();
    host.classList.add('pkm-substrip');

    const registry = ctx.plugin?.subTaskRegistry;
    const rows = registry?.list
        ? buildStripModel({
            tasks: safeCall(() => registry.list!(), [] as SubTask[]),
            pending: safeCall(() => ctx.plugin?.subTaskNotifier?.pending?.() ?? [], [] as SubTask[]),
            tabKey: ctx.tabKey,
            agentName: ctx.agentName,
            sessionPath: ctx.sessionPath || '',
        })
        : [];

    host.classList.toggle('pkm-substrip--empty', rows.length === 0);
    if (rows.length === 0) return 0;

    const expanded = rows.find(row => row.id === ctx.expandedId) || null;

    const chips = host.createDiv({ cls: 'pkm-substrip__chips' });
    for (const row of rows) renderChip(chips, row, ctx, expanded?.id === row.id);

    // Szczegół rozwija się POD paskiem chipów — jeden naraz, żeby okno czatu nie urosło
    // userowi pod palcami przy pięciu biegach.
    if (expanded) renderDetail(host.createDiv({ cls: 'pkm-substrip__detail' }), expanded, registry);

    return rows.length;
}

// ── Wnętrzności ──────────────────────────────────────────────────────

function renderChip(chips: El, row: StripRow, ctx: SubTaskStripContext, isExpanded: boolean): void {
    const cls = 'pkm-substrip__chip'
        + (isExpanded ? ' pkm-substrip__chip--open' : '')
        + (row.waiting ? ' pkm-substrip__chip--waiting' : '');
    // Front B: podpowiedź chipa niesie też skrót zadania — user widzi PO CO bieg, bez rozwijania.
    const hint = row.taskPreview
        ? `${statusLabel(row)} — ${row.taskPreview.slice(0, 120)}${row.taskPreview.length > 120 ? '…' : ''}`
        : statusLabel(row);
    const chip = chips.createEl('button', {
        cls,
        attr: {
            type: 'button',
            'aria-label': t('chat.substrip.chip_aria', { name: row.name, status: statusLabel(row) }),
            title: hint,
        },
    });

    const crystalCls = `pkm-substrip__crystal ${STATUS_CLASS[row.status] || ''}`
        + (row.status === 'running' ? ' cs-breathing' : '');
    const crystal = chip.createSpan({ cls: crystalCls });
    setSvg(crystal, SkinManager.getCrystal(row.name, { size: 12, color: 'currentColor', glow: false }));

    chip.createSpan({ cls: 'pkm-substrip__name', text: row.name });
    chip.createSpan({ cls: 'pkm-substrip__time', text: formatDuration(row.durationMs) });

    chip.addEventListener('click', (event: Event) => {
        event.stopPropagation();
        // Ponowny klik w rozwinięty chip zwija szczegół (zero „zamknij" do szukania).
        ctx.onToggle(isExpanded ? null : row.id);
    });
}

function renderDetail(details: El, row: StripRow, registry: RegistryLike | null | undefined): void {
    const head = details.createDiv({ cls: 'pkm-substrip__detail-head' });
    head.createSpan({ cls: 'pkm-substrip__detail-status', text: statusLabel(row) });
    head.createSpan({
        cls: 'pkm-substrip__detail-meta',
        text: [
            formatDuration(row.durationMs),
            t('chat.substrip.meta_steps', { count: String(row.stepCount) }),
            t('chat.substrip.meta_tools', { count: String(row.toolCallCount) }),
        ].join(' · '),
    });

    // Stop TYLKO dla biegu w toku — do zakończonego nie ma czego wysyłać.
    if (row.status === 'running') renderStopButton(head, registry, row);

    // Front B: zadanie od maina NAD krokami — najpierw „po co ten bieg", potem „co klika".
    if (row.taskPreview) {
        const taskTitle = details.createDiv({ cls: 'pkm-substrip__section-title' });
        taskTitle.textContent = t('chat.substrip.details_task');
        details.createDiv({ cls: 'pkm-substrip__task', text: row.taskPreview });
    }

    if (row.recentSteps.length === 0) {
        details.createDiv({ cls: 'pkm-substrip__empty', text: t('chat.substrip.no_steps') });
    } else {
        const title = details.createDiv({ cls: 'pkm-substrip__section-title' });
        title.textContent = t('chat.substrip.details_steps', { count: String(row.recentSteps.length) });
        const list = details.createDiv({ cls: 'pkm-substrip__steps' });
        for (const step of row.recentSteps) renderStep(list, step);
    }

    if (!row.outcome) return;
    const outcomeTitle = details.createDiv({ cls: 'pkm-substrip__section-title' });
    outcomeTitle.textContent = row.status === 'error'
        ? t('chat.substrip.details_error')
        : t('chat.substrip.details_outcome');
    details.createDiv({
        cls: `pkm-substrip__outcome${row.status === 'error' ? ' pkm-substrip__outcome--error' : ''}`,
        text: row.outcome,
    });
}

/**
 * „Stop" to PROŚBA, nie egzekucja: rejestr zapisuje znacznik i pociąga uchwyt abortu
 * wstrzyknięty przez `DelegateTool`, a bieg gaśnie dopiero, gdy pętla suba dojedzie do
 * najbliższego punktu przerwania. Stąd „zatrzymywanie…" zamiast natychmiastowego zniknięcia.
 */
function renderStopButton(head: El, registry: RegistryLike | null | undefined, row: StripRow): void {
    const stopBtn = head.createEl('button', {
        cls: 'pkm-substrip__stop',
        attr: { type: 'button', 'aria-label': t('chat.substrip.stop_aria', { name: row.name }) },
    });

    const setStopping = () => {
        stopBtn.textContent = t('chat.substrip.stopping');
        stopBtn.disabled = true;
        stopBtn.classList.add('pkm-substrip__stop--pending');
    };

    // Prośba już poszła, bieg jeszcze nie stanął — guzik nie może kusić drugim kliknięciem.
    if (row.stopRequested) setStopping();
    else stopBtn.textContent = t('chat.substrip.stop');

    stopBtn.addEventListener('click', (event: Event) => {
        event.stopPropagation();
        setStopping();
        safeCall(() => registry?.requestStop?.(row.id), false);
    });
}

function renderStep(list: El, step: StripStep): void {
    const line = list.createDiv({ cls: 'pkm-substrip__step' });
    line.createSpan({ cls: 'pkm-substrip__step-time', text: formatClock(step.at) });
    line.createSpan({ cls: 'pkm-substrip__step-type', text: step.type });
    if (step.tool) line.createSpan({ cls: 'pkm-substrip__step-tool', text: step.tool });
    // Front B: konkret kroku (ścieżka / zapytanie / rozmiar wyniku) — koniec zgadywania,
    // co sub właściwie czyta. Model przycina do 80 znaków, CSS dokłada elipsę.
    if (step.detail) line.createSpan({ cls: 'pkm-substrip__step-detail', text: step.detail });
}

/** Godzina kroku (HH:MM:SS) — data jest bez znaczenia, biegi żyją minuty. */
function formatClock(at: number): string {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
