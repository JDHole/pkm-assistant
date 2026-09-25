import test from 'ava';
import { replaceMentionAutocomplete } from './inputLifecycle.js';

test('replaceMentionAutocomplete destroys the previous instance and stores the new one', t => {
    let destroyCount = 0;
    const previous = { destroy: () => { destroyCount++; } };
    const next = { destroy() {} };
    const host = { mentionAutocomplete: previous };
    let createCount = 0;

    replaceMentionAutocomplete(host, () => {
        createCount++;
        return next;
    });

    t.is(destroyCount, 1);
    t.is(createCount, 1);
    t.is(host.mentionAutocomplete, next);
});
