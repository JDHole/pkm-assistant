import test from 'ava';
import { findActiveChatView } from './findActiveChatView.js';
import { CHAT_VIEW_TYPE } from '../../../core/index.js';

// AUD-dead-code-182: `TriggersView.ts` used to carry its own local
// `CHAT_VIEW_TYPE = 'pkm-chat'` — a stale copy of the real chat view-type id
// (`'pkm-assistant-chat'`, `modules/chat/chat_view.ts`). `getLeavesOfType` matches
// view types EXACTLY, so `findActiveChatView` always came back empty even with a
// chat tab open. This test asserts the ARGUMENT the function hands to
// `getLeavesOfType`, not just the mock's return value passed through — a return-only
// assertion would pass just as happily with the wrong string.
test('findActiveChatView asks the workspace for leaves of the canonical chat view type', t => {
    const seenTypes: string[] = [];
    const workspace = {
        getLeavesOfType: (type: string) => {
            seenTypes.push(type);
            return [];
        },
        activeLeaf: null,
    };
    const plugin = { app: { workspace } };

    findActiveChatView(plugin);

    t.deepEqual(seenTypes, [CHAT_VIEW_TYPE]);
    t.is(seenTypes[0], 'pkm-assistant-chat');
});

test('findActiveChatView returns null when the workspace has no matching leaves', t => {
    const workspace = { getLeavesOfType: () => [], activeLeaf: null };
    const plugin = { app: { workspace } };

    t.is(findActiveChatView(plugin), null);
});

test('findActiveChatView returns null when plugin/app/workspace is missing', t => {
    t.is(findActiveChatView(null), null);
    t.is(findActiveChatView({}), null);
    t.is(findActiveChatView({ app: {} }), null);
});

test('findActiveChatView prefers the active leaf, falls back to the first leaf', t => {
    const activeLeaf = { view: { id: 'active' } };
    const otherLeaf = { view: { id: 'other' } };
    const workspaceActive = {
        getLeavesOfType: () => [otherLeaf, activeLeaf],
        activeLeaf,
    };
    t.is(findActiveChatView({ app: { workspace: workspaceActive } }), activeLeaf.view);

    const workspaceNoneActive = {
        getLeavesOfType: () => [otherLeaf, activeLeaf],
        activeLeaf: null,
    };
    t.is(findActiveChatView({ app: { workspace: workspaceNoneActive } }), otherLeaf.view);
});
