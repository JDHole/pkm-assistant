import test from 'ava';
import { stripRunnerQuestion } from './stripRunnerQuestion.js';

test('wycina wyłącznie przekazaną dokładną notkę', t => {
    const note = 'The s…';
    t.is(stripRunnerQuestion(`${note}\n\nDOROBEK`, note), 'DOROBEK');
    t.is(stripRunnerQuestion('The sub-agent received no answer to the question: First…\n\nDOROBEK', 'First? Second?'), 'The sub-agent received no answer to the question: First…\n\nDOROBEK');
});

test('usuwa tylko dokładną notkę na początku, zachowując cytat i inne prefiksy', t => {
    const question = 'First?\n\nSecond?\n\n';
    const sentence = `The sub-agent received no answer to the question: ${question}`;
    const quote = 'Materiał\n\nThe sub-agent received no answer to the question: First?\n\nSecond?';
    t.is(stripRunnerQuestion(`${sentence}\n\n${quote}`, sentence), quote);
    t.is(stripRunnerQuestion(quote, sentence), quote);
    t.is(stripRunnerQuestion('The sub-agent received no answer to the question: Fir…\n\nWynik', undefined), 'The sub-agent received no answer to the question: Fir…\n\nWynik');
    t.is(stripRunnerQuestion('The sub-agent received no answer to the question: Foo…\n\nWynik', sentence), 'The sub-agent received no answer to the question: Foo…\n\nWynik');
    t.is(stripRunnerQuestion('The sub-agent received no answer to the question: Fir… dalszy tekst', sentence), 'The sub-agent received no answer to the question: Fir… dalszy tekst');
});
