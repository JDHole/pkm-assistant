/**
 * ApprovalModal
 * Modal for approving/denying agent actions.
 * i18n-aware UI, content preview, deny reason field.
 */
import { Modal } from 'obsidian';
import { UiIcons, setSvg } from '../../modules/crystal-soul/index.js';
import { t } from '../../core/i18n/index.js';

// TS-any: approval payloads are open-ended tool action records assembled by heterogeneous runtime tools.
type Runtime = any;

/** Sufit długości JSON-a argumentów w modalu (dłuższe tniemy z dopiskiem). */
const EXTERNAL_ARGS_LIMIT = 1500;

export class ApprovalModal extends Modal {
    declare private action: Runtime;
    declare private result: Runtime;
    declare private resolvePromise: Runtime;
    /**
     * @param {App} app - Obsidian App
     * @param {Object} action - Action to approve
     * @param {string} action.type - Action type (e.g., 'vault.write', 'vault.delete')
     * @param {string} action.description - Human-readable description
     * @param {string} action.targetPath - Target file path
     * @param {string} [action.preview] - Optional preview summary
     * @param {string} [action.contentPreview] - Actual content for vault_write
     * @param {string} action.agentName - Name of the agent requesting
     */
    constructor(app: Runtime, action: Runtime) {
        super(app);
        this.action = action;
        this.result = null;
        this.resolvePromise = null;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('pkm-approval-modal');

        // Header with warning icon
        const header = contentEl.createDiv('approval-header');
        const h2 = header.createEl('h2');
        setSvg(h2, UiIcons.warning(20));
        h2.appendText(t('approval.title'));

        // Agent action description (human-readable)
        const agentInfo = contentEl.createDiv('approval-agent');
        agentInfo.createEl('p', {
            text: this._getHumanDescription()
        });

        // Action details
        const details = contentEl.createDiv('approval-details');

        // Action type badge
        const typeBadge = details.createSpan({
            cls: `action-badge action-${this._getActionSeverity()}`
        });
        const [typeIcon, typeLabel] = this._getActionLabel();
        setSvg(typeBadge, typeIcon);
        typeBadge.appendText(typeLabel);

        // Target path
        if (this.action.targetPath) {
            const pathEl = details.createDiv('action-path');
            const folderIcon = pathEl.createSpan();
            setSvg(folderIcon, UiIcons.folder(14));
            folderIcon.appendText(' ');
            pathEl.createEl('code', { text: this.action.targetPath });
        }

        // Źródło operacji, gdy narzędzie dotyka DWÓCH plików.
        // `add_text_to_image` czyta jeden obraz i zapisuje drugi - wyżej widać wyłącznie cel,
        // więc bez tego pola user zatwierdzałby połowę operacji, nie wiedząc, SKĄD plik zostanie wzięty.
        // Pole jest opcjonalne: narzędzia jednościeżkowe go nie podają i nic się nie zmienia.
        if (this.action.sourcePath) {
            const srcEl = details.createDiv('action-path action-source-path');
            const srcIcon = srcEl.createSpan();
            setSvg(srcIcon, UiIcons.image(14));
            srcIcon.appendText(' ');
            srcEl.createSpan({ text: `${t('approval.source_label')} ` });
            srcEl.createEl('code', { text: String(this.action.sourcePath) });
        }

        // Content preview - different per action type
        this._renderContentPreview(contentEl);

        // Deny reason field (hidden by default)
        const denyReasonDiv = contentEl.createDiv({ cls: 'approval-deny-reason pkm-hidden' });
        denyReasonDiv.createEl('label', { text: t('approval.deny_reason') });
        const denyReasonInput = denyReasonDiv.createEl('input', {
            type: 'text',
            placeholder: t('approval.deny_placeholder'),
            cls: 'approval-deny-input'
        });
        denyReasonInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this._resolve({ result: 'deny', reason: denyReasonInput.value.trim() });
            }
        });

        // Redirect instruction field (hidden by default) - third path: stop + steer.
        const redirectDiv = contentEl.createDiv({ cls: 'approval-redirect-reason pkm-hidden' });
        redirectDiv.createEl('label', { text: t('approval.redirect_label') });
        const redirectInput = redirectDiv.createEl('textarea', {
            placeholder: t('approval.redirect_placeholder'),
            cls: 'approval-redirect-input'
        });
        redirectInput.rows = 2;
        // Ctrl/Cmd+Enter = wygodny skrót potwierdzenia (Enter w textarea = nowa linia).
        redirectInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this._confirmRedirect(redirectInput.value.trim());
            }
        });

        // Buttons
        const buttonContainer = contentEl.createDiv('approval-buttons');

        // Deny button - first click shows reason field, second confirms
        let denyClicked = false;
        const denyBtn = buttonContainer.createEl('button', {
            cls: 'mod-warning'
        });
        setSvg(denyBtn, UiIcons.cross(14));
        denyBtn.appendText(t('approval.deny'));
        denyBtn.onclick = () => {
            if (!denyClicked) {
                denyClicked = true;
                denyReasonDiv.removeClass('pkm-hidden');
                setSvg(denyBtn, UiIcons.cross(14));
                denyBtn.appendText(t('approval.confirm_deny'));
                denyReasonInput.focus();
            } else {
                this._resolve({ result: 'deny', reason: denyReasonInput.value.trim() });
            }
        };

        // Approve button
        const approveBtn = buttonContainer.createEl('button', {
            cls: 'mod-cta'
        });
        setSvg(approveBtn, UiIcons.check(14));
        approveBtn.appendText(t('approval.approve'));
        approveBtn.onclick = () => this._resolve({ result: 'approve', reason: '' });

        // Always approve button. Dla narzędzia zewnętrznego serwera „zawsze"
        // dotyczy TEGO KONKRETNEGO narzędzia (reguła external.call::serverId__tool, nie hurt),
        // więc etykieta + tooltip mówią to wprost.
        const isExternalCall = this.action.type === 'external.call';
        const alwaysBtn = buttonContainer.createEl('button', {
            cls: 'mod-muted'
        });
        setSvg(alwaysBtn, UiIcons.refresh(14));
        alwaysBtn.appendText(isExternalCall ? t('approval.always_this_tool') : t('approval.approve_session'));
        if (isExternalCall) alwaysBtn.title = t('approval.always_this_tool_desc');
        alwaysBtn.onclick = () => this._resolve({ result: 'always', reason: '' });

        // Redirect button - third path: stop the action and tell the agent what to do
        // instead. First click reveals the instruction field, second click confirms.
        let redirectClicked = false;
        const redirectBtn = buttonContainer.createEl('button', {
            cls: 'mod-muted'
        });
        setSvg(redirectBtn, UiIcons.compass(14));
        redirectBtn.appendText(t('approval.redirect'));
        redirectBtn.onclick = () => {
            if (!redirectClicked) {
                redirectClicked = true;
                redirectDiv.removeClass('pkm-hidden');
                setSvg(redirectBtn, UiIcons.compass(14));
                redirectBtn.appendText(t('approval.confirm_redirect'));
                redirectInput.focus();
            } else {
                this._confirmRedirect(redirectInput.value.trim());
            }
        };
    }

    /**
     * Confirm a redirect. Empty instruction → treat as a plain deny (never create an
     * empty redirect). Non-empty → resolve with {result:'redirect', instruction}.
     * @param {string} instruction
     */
    _confirmRedirect(instruction: string): void {
        if (!instruction) {
            this._resolve({ result: 'deny', reason: '' });
            return;
        }
        this._resolve({ result: 'redirect', instruction });
    }

    _getHumanDescription() {
        const name = this.action.agentName || 'AI';
        const a = this.action;

        switch (a.type) {
            case 'vault.write': {
                const path = a.targetPath || t('approval.fallback.file');
                const modeLabels: Record<string, string> = {
                    'create': t('approval.verb.create'),
                    'append': t('approval.verb.append'),
                    'prepend': t('approval.verb.prepend'),
                    'replace': t('approval.verb.overwrite'),
                    'patch': t('approval.verb.patch')
                };
                const verb = a.operationMode && modeLabels[a.operationMode]
                    ? modeLabels[a.operationMode]
                    : t('approval.verb.default_write');
                return t('approval.desc.vault_write', { name, verb, path });
            }
            case 'vault.delete':
                return t('approval.desc.vault_delete', { name, path: a.targetPath || t('approval.fallback.file') });
            case 'vault.create_folder':
                return t('approval.desc.vault_create_folder', { name, path: a.targetPath || t('approval.fallback.folder') });
            case 'memory.write': {
                const isDelete = a.toolName === 'memory_delete';
                const verb = isDelete ? t('approval.verb.forget') : t('approval.verb.remember');
                const content = a.memoryContent
                    ? (a.memoryContent.length > 80 ? a.memoryContent.slice(0, 80) + '...' : a.memoryContent)
                    : '';
                const section = a.memorySection ? ` (${a.memorySection})` : '';
                return t('approval.desc.memory_save', { name, verb, content: content + section });
            }
            case 'agent.message': {
                const target = a.targetPath || t('approval.fallback.agent');
                if (a.messageSubject) {
                    return t('approval.desc.agent_message_subject', { name, target, subject: a.messageSubject });
                }
                return t('approval.desc.agent_message', { name, target });
            }
            case 'web.search':
                return t('approval.desc.web_search', { name, query: a.targetPath || t('approval.fallback.query') });
            // Pobranie adresu to nie wyszukiwanie - opis ma mowic,
            // co naprawde sie stanie (zadanie HTTP pod adres wskazany przez model).
            case 'web.read':
                return t('approval.desc.web_read', { name, url: a.targetPath || t('approval.fallback.query') });
            case 'image.generate': {
                // `targetPath` to ŚCIEŻKA ZAPISU (bramka musi
                // oceniać cel, nie tekst modelu), więc prompt przyjeżdża osobnym polem.
                // `add_text_to_image` promptu nie ma - wtedy user widzi ścieżkę, i słusznie.
                const prompt = a.imagePrompt || a.targetPath || t('approval.fallback.image');
                const short = prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt;
                return t('approval.desc.generate_image', { name, prompt: short });
            }
            case 'mcp.call':
                return t('approval.desc.default', { name });
            case 'external.call': {
                // Narzędzie zewnętrznego serwera MCP. Pokaż serwer + odprefiksowaną nazwę.
                const server = a.externalServer || t('approval.fallback.server');
                const prefix = a.externalServer ? `${a.externalServer}__` : '';
                const rawTool = a.approvalTarget || a.toolName || '';
                const toolLabel = (prefix && rawTool.startsWith(prefix)) ? rawTool.slice(prefix.length) : rawTool;
                return t('approval.desc.external_call', { name, server, tool: toolLabel });
            }
            default:
                // Group B tools
                if (a.toolName === 'delegate')
                    return t('approval.desc.delegate', { name, task: a.targetPath || t('approval.fallback.task') });
                if (a.toolName === 'connect_to_server')
                    return t('approval.desc.connect_to_server', { name, server: a.serverName || a.targetPath || t('approval.fallback.server') });
                if (a.toolName === 'skill_execute')
                    return t('approval.desc.skill_execute', { name, skill: a.targetPath || t('approval.fallback.skill') });
                return t('approval.desc.generic', { name, action: a.toolName || a.type });
        }
    }

    /** @returns {[string, string]} `[iconMarkup, labelText]` - label is ALWAYS inserted as text. */
    _getActionLabel() {
        const labels: Record<string, [Runtime, string]> = {
            'vault.write': [UiIcons.edit(14), t('approval.type.vault_write')],
            'vault.delete': [UiIcons.trash(14), t('approval.type.vault_delete')],
            'vault.create_folder': [UiIcons.folder(14), t('approval.type.vault_create_folder')],
            'memory.write': [UiIcons.brain(14), t('approval.type.memory_save')],
            'agent.message': [UiIcons.send(14), t('approval.type.agent_message')],
            'web.search': [UiIcons.search(14), t('approval.type.web_search')],
            'web.read': [UiIcons.globe(14), t('approval.type.web_read')],
            'image.generate': [UiIcons.image(14), t('approval.type.generate_image')],
            'mcp.call': [UiIcons.wrench(14), t('approval.type.mcp_call')],
            'external.call': [UiIcons.wrench(14), t('approval.type.external_call')]
        };
        return labels[this.action.type] || ['', this.action.type];
    }

    _getActionSeverity() {
        const severities: Record<string, string> = {
            'vault.delete': 'danger',
            'vault.write': 'warning',
            'memory.write': 'warning',
            'agent.message': 'info',
            'web.search': 'info',
            'web.read': 'warning',
            'image.generate': 'info',
            'vault.create_folder': 'info',
            'todo.save': 'info',
            'mcp.call': 'info',
            // Cudzy serwer/kod = RED w łańcuchu ryzyka → badge „danger".
            'external.call': 'danger'
        };
        return severities[this.action.type] || 'info';
    }

    /**
     * Pełne argumenty wywołania narzędzia zewnętrznego serwera. User zatwierdza
     * KONKRETNE dane lecące do cudzego procesu/usługi, nie samą nazwę narzędzia.
     * Znaczniki `_invocation*` są odcięte wcześniej (MCPClient → stripInternalArgs).
     * @param {HTMLElement} contentEl
     */
    _renderExternalArgs(contentEl: Runtime): void {
        const args = this.action.externalArgs;
        const previewSection = contentEl.createDiv('approval-preview');
        previewSection.createEl('h4', { text: t('approval.preview.external_args') });

        const hasArgs = args && typeof args === 'object' && Object.keys(args).length > 0;
        let text;
        if (!hasArgs) {
            text = t('approval.preview.external_args_empty');
        } else {
            try {
                text = JSON.stringify(args, null, 2);
            } catch {
                text = String(args);
            }
            if (text.length > EXTERNAL_ARGS_LIMIT) {
                text = text.slice(0, EXTERNAL_ARGS_LIMIT) + '\n' + t('approval.preview.external_args_truncated');
            }
        }
        previewSection.createEl('pre', { cls: 'approval-content-preview' }).createEl('code', { text });
    }

    _renderContentPreview(contentEl: Runtime): void {
        const a = this.action;

        if (a.type === 'external.call') {
            // Zewnętrzny serwer MCP - zamiast ogólnego preview pokazujemy pełne argumenty.
            this._renderExternalArgs(contentEl);
        } else if (a.type === 'agent.message' && a.messageContent) {
            // Message preview
            const previewSection = contentEl.createDiv('approval-preview');
            previewSection.createEl('h4', { text: t('approval.preview.message_content') });
            const truncated = a.messageContent.length > 500
                ? a.messageContent.slice(0, 500) + '\n' + t('approval.preview.truncated')
                : a.messageContent;
            previewSection.createEl('pre', { cls: 'approval-content-preview' }).createEl('code', { text: truncated });
        } else if (a.type === 'memory.write' && a.memoryContent) {
            // Memory content preview
            const previewSection = contentEl.createDiv('approval-preview');
            const label = a.memoryOperation === 'delete_from_brain'
                ? t('approval.preview.will_be_deleted')
                : t('approval.preview.will_be_remembered');
            previewSection.createEl('h4', { text: label });
            previewSection.createEl('pre', { cls: 'approval-content-preview' }).createEl('code', { text: a.memoryContent });
            if (a.memoryOldContent) {
                previewSection.createEl('h4', { text: t('approval.preview.replaces') });
                previewSection.createEl('pre', { cls: 'approval-content-preview' }).createEl('code', { text: a.memoryOldContent });
            }
        } else if (a.contentPreview) {
            // vault_write content preview
            const previewSection = contentEl.createDiv('approval-preview');
            previewSection.createEl('h4', { text: t('approval.preview.will_be_saved') });
            const truncated = a.contentPreview.length > 500
                ? a.contentPreview.slice(0, 500) + '\n' + t('approval.preview.truncated')
                : a.contentPreview;
            previewSection.createEl('pre', { cls: 'approval-content-preview' }).createEl('code', { text: truncated });
        } else if (a.preview) {
            // Fallback: old-style preview
            const previewSection = contentEl.createDiv('approval-preview');
            previewSection.createEl('h4', { text: t('approval.preview.details') });
            previewSection.createEl('pre').createEl('code', { text: a.preview });
        }
    }

    _resolve(result: Runtime): void {
        this.result = result;
        if (this.resolvePromise) {
            this.resolvePromise(result);
        }
        this.close();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();

        // If closed without action, treat as deny
        if (this.result === null && this.resolvePromise) {
            this.resolvePromise({ result: 'deny', reason: '' });
        }
    }

    /**
     * Show modal and wait for user response
     * @returns {Promise<{result: 'approve'|'deny'|'always'|'redirect', reason?: string, instruction?: string}>}
     */
    async waitForResponse() {
        return new Promise((resolve) => {
            this.resolvePromise = resolve;
            this.open();
        });
    }
}

/**
 * Request approval for an action
 * @param {App} app
 * @param {Object} action
 * @returns {Promise<{result: 'approve'|'deny'|'always', reason: string}>}
 */
export async function requestApproval(app: Runtime, action: Runtime): Promise<Runtime> {
    const modal = new ApprovalModal(app, action);
    return modal.waitForResponse();
}
