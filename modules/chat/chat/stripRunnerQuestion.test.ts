import test from 'ava';
import { stripRunnerQuestion } from './stripRunnerQuestion.js';

test('usuwa tylko znane zdanie na początku, zachowując cytat i inne prefiksy', t => {
    const question = 'First?\n\nSecond?\n\n';
    const sentence = `The sub-agent received no answer to the question: ${question}`;
    const quote = 'Materiał\n\nThe sub-agent received no answer to the question: First?\n\nSecond?';
    t.is(stripRunnerQuestion(`${sentence}\n\n${quote}`, question), quote);
    t.is(stripRunnerQuestion(quote, question), quote);
    t.is(stripRunnerQuestion('The sub-agent received no answer to the question: Fir…\n\nWynik', question), 'Wynik');
    t.is(stripRunnerQuestion('The sub-agent received no answer to the question: Foo…\n\nWynik', question), 'The sub-agent received no answer to the question: Foo…\n\nWynik');
    t.is(stripRunnerQuestion('The sub-agent received no answer to the question: Fir… dalszy tekst', question), 'The sub-agent received no answer to the question: Fir… dalszy tekst');
});
