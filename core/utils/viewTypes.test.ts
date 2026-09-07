import test from 'ava';
import { CHAT_VIEW_TYPE } from './viewTypes.js';

// AUD-dead-code-182: test-pin. `CHAT_VIEW_TYPE` is the Obsidian view-type id
// persisted on disk per leaf (workspace layout). Changing this literal silently
// orphans every user's saved layout — the old leaf keeps pointing at a view type
// nothing registers anymore, and Obsidian just drops it. If this test needs
// updating, that is a signal to write a layout migration first, not to bump the
// literal here.
test('CHAT_VIEW_TYPE is pinned to the registered chat view type', t => {
    t.is(CHAT_VIEW_TYPE, 'pkm-assistant-chat');
});
