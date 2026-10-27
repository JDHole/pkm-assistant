import test from 'ava';

test('B4: niezależne moduły nadają różne pierwsze ID tej samej nazwie', async t => {
    const firstPath = './subTaskId.js?first-process';
    const secondPath = './subTaskId.js?second-process';
    const first = await import(firstPath) as typeof import('./subTaskId.js');
    const second = await import(secondPath) as typeof import('./subTaskId.js');
    const a = first.allocateSubTaskId('worker');
    const b = second.allocateSubTaskId('worker');
    t.regex(a, /^sub\/worker#[a-f0-9]{8}-1$/);
    t.regex(b, /^sub\/worker#[a-f0-9]{8}-1$/);
    t.not(a, b);
});
