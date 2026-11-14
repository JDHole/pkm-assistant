import test from 'ava';
import { closeTriggerPopup, scheduleTriggerPopupOpen, mobileTriggerPosition } from './triggerPopupLifecycle.js';

const typedSlash = {
    isMobile: true, popupOpen: false, openScheduled: false,
    inputType: 'insertText', data: '/', value: '/', selectionStart: 1, selectionEnd: 1,
};
const inputCases: Array<[string, Partial<Parameters<typeof mobileTriggerPosition>[0]>, number | null]> = [
    ['start', {}, 0],
    ['space', { value: 'hi /', selectionStart: 4, selectionEnd: 4 }, 3],
    ['newline', { value: 'hi\n/', selectionStart: 4, selectionEnd: 4 }, 3],
    ['tab', { value: '\t/', selectionStart: 2, selectionEnd: 2 }, 1],
    ['mid-word', { value: 'a/', selectionStart: 2, selectionEnd: 2 }, null],
    ['URL', { value: 'http://', selectionStart: 7, selectionEnd: 7 }, null],
    ['paste', { inputType: 'insertFromPaste', data: 'hi /', value: 'hi /', selectionStart: 4, selectionEnd: 4 }, null],
    ['drop', { inputType: 'insertFromDrop' }, null],
    ['delete after slash', { inputType: 'deleteContentBackward', data: null }, null],
    ['undo', { inputType: 'historyUndo', data: null }, null],
    ['redo', { inputType: 'historyRedo', data: null }, null],
    ['autocorrect', { inputType: 'insertReplacementText' }, null],
    ['open', { popupOpen: true }, null],
    ['scheduled', { openScheduled: true }, null],
    ['composition', { inputType: 'insertCompositionText' }, 0],
    ['composition string', { inputType: 'insertCompositionText', data: 'hi /', value: 'hi /', selectionStart: 4, selectionEnd: 4 }, 3],
    ['desktop', { isMobile: false }, null],
    ['no input metadata', { inputType: undefined, data: undefined }, null],
    ['null data', { data: null }, null],
    ['empty data', { data: '' }, null],
    ['slash is not last inserted character', { data: '/a' }, null],
    ['caret before slash', { selectionStart: 0, selectionEnd: 0 }, null],
    ['caret after another character', { value: '/a', selectionStart: 2, selectionEnd: 2 }, null],
    ['selection remains', { value: '/a', selectionEnd: 2 }, null],
    ['in middle of field', { value: '/later' }, 0],
];
for (const [name, changes, expected] of inputCases) {
    test(`mobile slash input decision: ${name}`, t => {
        t.is(mobileTriggerPosition({ ...typedSlash, ...changes }), expected);
    });
}

test('zamyka oczekujace otwarcie popupu i kasuje uchwyt timera', async t => {
    const host: { _triggerPopup: { close: () => void } | null; _triggerOpenTimer: number | null } = {
        _triggerPopup: null,
        _triggerOpenTimer: null,
    };
    let opened = false;
    scheduleTriggerPopupOpen(host, () => { opened = true; });
    closeTriggerPopup(host);
    await new Promise(resolve => setTimeout(resolve, 5));

    t.false(opened);
    t.is(host._triggerOpenTimer, null);
});

test('zamyka popup i usuwa go z hosta', t => {
    let closeCount = 0;
    const host: { _triggerPopup: { close: () => void } | null; _triggerOpenTimer: number | null } = {
        _triggerPopup: { close: () => { closeCount++; } },
        _triggerOpenTimer: null,
    };
    closeTriggerPopup(host);

    t.is(closeCount, 1);
    t.is(host._triggerPopup, null);
});

test('closeTriggerPopup kasuje popup i timer hosta', t => {
    let closeCount = 0;
    const host: { _triggerPopup: { close: () => void } | null; _triggerOpenTimer: number | null } = {
        _triggerPopup: { close: () => { closeCount++; } },
        _triggerOpenTimer: null as number | null,
    };
    scheduleTriggerPopupOpen(host, () => { throw new Error('old popup should not open'); });
    closeTriggerPopup(host);

    t.is(closeCount, 1);
    t.is(host._triggerPopup, null);
    t.is(host._triggerOpenTimer, null);
});
