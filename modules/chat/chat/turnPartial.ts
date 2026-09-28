import { maskSensitiveData } from '../../../core/index.js';
import { t } from '../../../core/i18n/index.js';
import type { AgentLoopPartialSnapshot } from '../../agent-loop/index.js';
import type { ActiveSessionEventInput } from '../../memory/index.js';
import type { RollingMessage, RollingWindow } from './RollingWindow.js';

interface PartialOwner {
    readonly agentName: string;
    readonly ownerTabKey: string;
    readonly sessionPath: string;
    readonly turnId: number;
    readonly rw: RollingWindow;
    readonly memory: { appendSessionEvent(path: string, event: ActiveSessionEventInput): Promise<string> } | null;
    readonly onChange?: (receipt: RollingMessage) => void;
}

/** One synchronous owner receipt and one observed, serialized event per revision. */
export class ChatTurnPartialState {
    readonly agentName: string;
    readonly ownerTabKey: string;
    readonly sessionPath: string;
    readonly turnId: number;
    private readonly owner: PartialOwner;
    private receipt: RollingMessage | undefined;
    private pending: Promise<void> = Promise.resolve();
    latest: AgentLoopPartialSnapshot | undefined;
    storageError = false;

    constructor(owner: PartialOwner) {
        this.owner = { ...owner };
        this.agentName = owner.agentName;
        this.ownerTabKey = owner.ownerTabKey;
        this.sessionPath = owner.sessionPath;
        this.turnId = owner.turnId;
    }

    publish(snapshot: AgentLoopPartialSnapshot): void {
        if (snapshot.revision <= (this.latest?.revision ?? 0)) return;
        snapshot = JSON.parse(maskSensitiveData(JSON.stringify(snapshot)).replace(/\b(https?:\/\/)[^\s/@"\\]+@/gi, '$1[REDACTED]@')) as AgentLoopPartialSnapshot;
        this.latest = snapshot;
        const content = maskSensitiveData(t('chat.streaming.partial_header') + '\n\n' + snapshot.text).slice(0, 12000);
        if (!this.receipt) {
            this.receipt = { role: 'system', content, _loopPartial: true };
            // No awaited addMessage/compression/model request in a partial observer.
            this.owner.rw.messages.push(this.receipt);
        }
        Object.assign(this.receipt, { content, _loopPartialRevision: snapshot.revision, _loopPartialSynthesis: snapshot.synthesis });
        this.owner.onChange?.(this.receipt);
        const event: ActiveSessionEventInput = {
            type: 'agent_loop_partial', role: 'system', agentName: this.agentName, content,
            result: { owner: { agentName: this.agentName, tabKey: this.ownerTabKey, sessionPath: this.sessionPath }, run: this.turnId, revision: snapshot.revision, snapshot },
        };
        this.pending = this.pending.then(async () => {
            if (!this.owner.memory || !this.sessionPath) throw new Error('missing frozen session');
            await this.owner.memory.appendSessionEvent(this.sessionPath, event);
        }).catch(() => {
            this.storageError = true;
            if (this.receipt) {
                this.receipt._loopPartialStorageError = true;
                const text = typeof this.receipt.content === 'string' ? this.receipt.content : '';
                const notice = t('chat.streaming.partial_storage_error');
                if (!text.includes(notice)) this.receipt.content = text.slice(0, 12000 - notice.length - 2) + '\n\n' + notice;
                this.owner.onChange?.(this.receipt);
            }
        });
    }

    persisted(): Promise<void> { return this.pending; }
}
