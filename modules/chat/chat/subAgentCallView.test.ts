import test from 'ava';
import { subAgentCallView } from './subAgentCallView.js';

test('wybiera blok sub-agenta dla delegate, task blokującego i pokwitowania w tle', t => {
    t.is(subAgentCallView('delegate', {}, undefined, 'pending'), 'block');
    t.is(subAgentCallView('delegate', {}, { success: false, error: 'stary wynik' }, 'result'), 'block');
    t.is(subAgentCallView('sub_agent', { action: 'task' }, undefined, 'pending'), 'block');
    t.is(subAgentCallView('sub_agent', { action: 'task' }, { success: false, outcome: { end: 'limit' } }, 'result'), 'block');
    t.is(subAgentCallView('sub_agent', { action: 'task' }, { success: true, outcome: { end: 'finished' } }, 'result'), 'block');
    t.is(subAgentCallView('sub_agent', { action: 'task' }, { started: true, task_id: 'sub/a#1' }, 'result'), 'block');
});

test('wybiera chip dla pozostałych akcji i odmowy task bez outcome', t => {
    for (const action of ['message', 'stop', 'close', 'list']) {
        t.is(subAgentCallView('sub_agent', { action }, { success: true }, 'result'), 'chip');
    }
    t.is(subAgentCallView('sub_agent', { action: 'task' }, { success: false, error: 'odmowa' }, 'result'), 'chip');
});
