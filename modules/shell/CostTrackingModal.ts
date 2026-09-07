/**
 * CostTrackingModal — Sprint 03 Z17.
 *
 * Wyświetla agregację kosztów LLM calls z `.pkm-assistant/cost_log.jsonl`
 * (zapisywane przez CostLog — archiwista + sub-agenci).
 *
 * Agregacje:
 *   - Total all-time
 *   - Per agent (Jaskier / Klara / ...)
 *   - Per dzień (last 30 days)
 *   - Per miesiąc (current + previous)
 *
 * Otwierany z Settings tab (sekcja "Koszty").
 */
import { Modal } from 'obsidian';
import { CostLog } from '../memory/index.js';
import { t } from '../../core/i18n/index.js';

// TS-any: the modal crosses the dynamic Obsidian plugin and persisted cost-log boundary.
type Runtime = any;

interface CostSummary {
    cost_usd: number;
    calls: number;
    input_tokens: number;
    output_tokens: number;
}

interface DetailedCostSummary extends CostSummary {
    cached_tokens: number;
    savings_usd: number;
}

interface CompactCostSummary {
    cost_usd: number;
    calls: number;
}

interface CostStats {
    total: DetailedCostSummary;
    byAgent: Record<string, DetailedCostSummary>;
    byDay: Record<string, CostSummary>;
    byMonth: Record<string, CompactCostSummary>;
    byModel: Record<string, CostSummary>;
}

function fmtUsd(n: unknown): string {
    if (typeof n !== 'number' || !isFinite(n)) return '-';
    if (n < 0.01) return `$${n.toFixed(4)}`;
    return `$${n.toFixed(2)}`;
}

export class CostTrackingModal extends Modal {
    declare private plugin: Runtime;

    constructor(app: Runtime, plugin: Runtime) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        const { contentEl, modalEl } = this;
        contentEl.empty();
        contentEl.addClass('cs-cost-tracking-modal');
        if (modalEl) modalEl.addClass('cs-cost-tracking-modal-wide');

        contentEl.createEl('h2', { text: t('modal.cost_tracking.title') || 'Koszty LLM (cost log)' });

        const desc = contentEl.createEl('p', { cls: 'cs-cost-desc' });
        desc.textContent = t('modal.cost_tracking.desc')
            || 'Koszty z .pkm-assistant/cost_log.jsonl (przybliżone — pricing per model 2026-04). Zapisywane przez archiwistę (Z10) + generator kontekstu sesji (Z11).';

        const status = contentEl.createDiv({ cls: 'cs-cost-status' });
        status.textContent = '⏳ Wczytywanie...';

        try {
            const vault = this.plugin?.app?.vault;
            if (!vault) {
                status.textContent = '✗ vault unavailable';
                return;
            }
            const costLog = new CostLog(vault);
            const entries = await costLog.readAll();

            if (entries.length === 0) {
                status.textContent = t('modal.cost_tracking.empty')
                    || 'Brak zarejestrowanych kosztów. Pierwszy archiwista lub sub-agent stworzy wpis.';
                return;
            }
            status.remove();

            const stats = this._aggregate(entries);

            // Section: Total
            const totalBox = contentEl.createDiv({ cls: 'cs-cost-section cs-cost-section--total' });
            totalBox.createEl('strong', { text: t('modal.cost_tracking.total') || 'TOTAL' });
            totalBox.createDiv({
                text: `${fmtUsd(stats.total.cost_usd)} (${stats.total.calls} calls, ${stats.total.input_tokens.toLocaleString()} → ${stats.total.output_tokens.toLocaleString()} tok)`
            });

            totalBox.createDiv({
                text: `Cache savings: ${stats.total.cached_tokens.toLocaleString()} tok (${fmtUsd(stats.total.savings_usd)})`
            });

            // Section: Per agent
            const agentBox = contentEl.createDiv({ cls: 'cs-cost-section' });
            agentBox.createEl('strong', { text: t('modal.cost_tracking.per_agent') || 'Per agent' });
            const agentTable = agentBox.createEl('table', { cls: 'cs-cost-table' });
            const aHeader = agentTable.createEl('tr');
            ['Agent', 'Calls', 'Input tok', 'Output tok', 'Cache saved', 'USD'].forEach(h => {
                aHeader.createEl('th', { text: h });
            });
            for (const [agent, info] of Object.entries(stats.byAgent).sort((a, b) => b[1].cost_usd - a[1].cost_usd)) {
                const tr = agentTable.createEl('tr');
                [agent, info.calls, info.input_tokens.toLocaleString(), info.output_tokens.toLocaleString(), info.cached_tokens.toLocaleString(), fmtUsd(info.cost_usd)].forEach(v => {
                    tr.createEl('td', { text: String(v) });
                });
            }

            // Section: Per day (last 14)
            const dayBox = contentEl.createDiv({ cls: 'cs-cost-section cs-cost-section--spaced' });
            dayBox.createEl('strong', { text: t('modal.cost_tracking.per_day') || 'Per dzień (last 14)' });
            const dayList = dayBox.createDiv({ cls: 'cs-cost-list' });
            const recentDays = Object.entries(stats.byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);
            for (const [day, info] of recentDays) {
                const row = dayList.createDiv();
                row.textContent = `${day}  ${fmtUsd(info.cost_usd).padStart(8)}  (${info.calls} calls)`;
            }

            const chartCanvas = dayBox.createEl('canvas', { cls: 'cs-cost-chart' });
            chartCanvas.width = 600;
            chartCanvas.height = 180;
            this._renderTokenChart(chartCanvas, Object.entries(stats.byDay).sort((a, b) => a[0].localeCompare(b[0])).slice(-14));

            // Section: Per month
            const monthBox = contentEl.createDiv({ cls: 'cs-cost-section cs-cost-section--spaced' });
            monthBox.createEl('strong', { text: t('modal.cost_tracking.per_month') || 'Per miesiąc' });
            const monthList = monthBox.createDiv({ cls: 'cs-cost-list' });
            for (const [month, info] of Object.entries(stats.byMonth).sort((a, b) => b[0].localeCompare(a[0]))) {
                const row = monthList.createDiv();
                row.textContent = `${month}  ${fmtUsd(info.cost_usd).padStart(8)}  (${info.calls} calls)`;
            }

            // Section: Per model
            if (Object.keys(stats.byModel).length > 0) {
                const modelBox = contentEl.createDiv({ cls: 'cs-cost-section cs-cost-section--spaced' });
                modelBox.createEl('strong', { text: t('modal.cost_tracking.per_model') || 'Per model' });
                const modelList = modelBox.createDiv({ cls: 'cs-cost-list' });
                for (const [model, info] of Object.entries(stats.byModel).sort((a, b) => b[1].cost_usd - a[1].cost_usd).slice(0, 10)) {
                    const row = modelList.createDiv();
                    row.textContent = `${model}  ${fmtUsd(info.cost_usd).padStart(8)}  (${info.calls} calls, ${(info.input_tokens + info.output_tokens).toLocaleString()} tok)`;
                }
            }

            // Footer: close button
            const footer = contentEl.createDiv({ cls: 'cs-cost-footer' });
            const closeBtn = footer.createEl('button', { text: t('generic.close') || 'Zamknij' });
            closeBtn.addEventListener('click', () => this.close());
        } catch (e: Runtime) {
            status.textContent = `✗ ${e.message}`;
        }
    }

    _aggregate(entries: Runtime[]): CostStats {
        const stats: CostStats = {
            total: { cost_usd: 0, calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, savings_usd: 0 },
            byAgent: {},
            byDay: {},
            byMonth: {},
            byModel: {}
        };
        for (const e of entries) {
            const cost = Number(e.cost_usd) || 0;
            const inT = Number(e.input_tokens) || 0;
            const outT = Number(e.output_tokens) || 0;
            const cachedT = Number(e.cached_tokens) || Number(e.cache?.cached_tokens) || 0;
            const savings = Number(e.savings_usd) || Number(e.cache?.savings_usd) || 0;
            stats.total.cost_usd += cost;
            stats.total.calls++;
            stats.total.input_tokens += inT;
            stats.total.output_tokens += outT;
            stats.total.cached_tokens += cachedT;
            stats.total.savings_usd += savings;

            const agent = e.agent || '?';
            if (!stats.byAgent[agent]) stats.byAgent[agent] = { cost_usd: 0, calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, savings_usd: 0 };
            stats.byAgent[agent].cost_usd += cost;
            stats.byAgent[agent].calls++;
            stats.byAgent[agent].input_tokens += inT;
            stats.byAgent[agent].output_tokens += outT;
            stats.byAgent[agent].cached_tokens += cachedT;
            stats.byAgent[agent].savings_usd += savings;

            const day = (e.ts || '').slice(0, 10);
            if (day) {
                if (!stats.byDay[day]) stats.byDay[day] = { cost_usd: 0, calls: 0, input_tokens: 0, output_tokens: 0 };
                stats.byDay[day].cost_usd += cost;
                stats.byDay[day].calls++;
                stats.byDay[day].input_tokens += inT;
                stats.byDay[day].output_tokens += outT;
            }
            const month = (e.ts || '').slice(0, 7);
            if (month) {
                if (!stats.byMonth[month]) stats.byMonth[month] = { cost_usd: 0, calls: 0 };
                stats.byMonth[month].cost_usd += cost;
                stats.byMonth[month].calls++;
            }
            const model = e.model || e.model_name || '?';
            if (model !== '?') {
                if (!stats.byModel[model]) stats.byModel[model] = { cost_usd: 0, calls: 0, input_tokens: 0, output_tokens: 0 };
                stats.byModel[model].cost_usd += cost;
                stats.byModel[model].calls++;
                stats.byModel[model].input_tokens += inT;
                stats.byModel[model].output_tokens += outT;
            }
        }
        return stats;
    }

    _renderTokenChart(canvas: HTMLCanvasElement, dayEntries: Array<[string, CostSummary]>): void {
        const ctx = canvas.getContext('2d');
        if (!ctx || dayEntries.length === 0) return;

        const width = canvas.width;
        const height = canvas.height;
        const pad = 28;
        const values = dayEntries.map(([, info]) => (info.input_tokens || 0) + (info.output_tokens || 0));
        const max = Math.max(1, ...values);

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--text-muted') || '#999';
        ctx.font = '11px sans-serif';
        ctx.fillText('Tokeny / dzien', pad, 16);

        const barWidth = Math.max(8, (width - pad * 2) / dayEntries.length - 4);
        dayEntries.forEach(([day, info], i) => {
            const tokens = (info.input_tokens || 0) + (info.output_tokens || 0);
            const x = pad + i * ((width - pad * 2) / dayEntries.length) + 2;
            const barHeight = Math.round((height - pad * 2) * (tokens / max));
            const y = height - pad - barHeight;
            ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--interactive-accent') || '#7B5EA7';
            ctx.fillRect(x, y, barWidth, barHeight);
            ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--text-muted') || '#999';
            ctx.fillText(day.slice(5), x, height - 8);
        });
    }
}
