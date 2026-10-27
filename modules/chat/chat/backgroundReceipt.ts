import { t } from '../../../core/i18n/index.js';
import type { ChatViewLike } from './chatViewShape.js';
import type { MachineView } from './machineMessage.js';
import { renderMachineTile } from './machineTile.js';

export function buildBackgroundReceiptText(startedList: Array<{ task_id?: string; name?: string }>, queued?: number): string {
    const lines: string[] = [];
    if (queued && queued > 0) lines.push(t('chat.subagent_background_queued', { count: queued }));
    lines.push(...startedList.map(task => t('chat.tile.sub.background_id', { id: task?.task_id || '?' })));
    return lines.join('\n');
}

/** Render first, then settle only the receipt belonging to this run. */
export async function renderNotificationWithReceipt(
    container: HTMLElement, plugin: ChatViewLike['plugin'], view: MachineView,
    taskId: string | null, schedule: () => void, stillActive: () => boolean = () => true,
): Promise<boolean> {
    const receipts = taskId ? Array.from(container.querySelectorAll('[data-subtask-receipt-id]'))
        .filter(el => el.getAttribute('data-subtask-receipt-id') === taskId) : [];
    const bottom = container.scrollHeight - container.clientHeight - container.scrollTop <= 150;
    const top = container.getBoundingClientRect().top;
    const anchor = bottom ? undefined : Array.from(container.querySelectorAll('*')).find(el =>
        !receipts.some(receipt => receipt === el || receipt.contains(el) || el.contains(receipt))
        && el.getBoundingClientRect().bottom > top);
    const anchorTop = anchor?.getBoundingClientRect().top;
    const focused = document.activeElement;
    const moveFocus = focused && receipts.some(receipt => receipt.contains(focused));
    const detached = createDiv();
    await renderMachineTile(detached, plugin, view);
    if (!stillActive()) return false;
    const newTile = detached.firstElementChild;
    while (detached.firstChild) container.appendChild(detached.firstChild);
    for (const receipt of receipts) receipt.remove();
    if (bottom) container.scrollTop = container.scrollHeight - container.clientHeight;
    else if (anchor && anchorTop !== undefined) container.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    if (moveFocus) (newTile?.querySelector<HTMLElement>('.cs-tile__head'))?.focus({ preventScroll: true });
    schedule();
    return true;
}
