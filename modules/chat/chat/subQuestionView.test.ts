import test from 'ava';
import { SubTaskRegistry } from '../../sub-agents/index.js';
import { QuestionTestClock } from '../../sub-agents/test-support/questionTestClock.js';
import { findOpenSubQuestion, answeredSubQuestion, renderAnsweredSubQuestion } from './subQuestionView.js';
import { register } from 'node:module';
import { createAskUserChannels } from '../../tools/index.js';
import { setLocale } from '../../../core/i18n/index.js';

test('powiązanie pytania wymaga otwartego pytania i pełnego właściciela sesji', t => {
    const owner = { agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' };
    const clock = new QuestionTestClock();
    const registry = new SubTaskRegistry({ questionClock: clock });
    registry.create({ id: 'r1', threadId: 's1', name: 'Klara', origin: owner, taskPreview: 'Zestawienie budżetu' });
    const opened = registry.openParentQuestion('r1', 'Jaki zakres?');
    if (opened.kind !== 'opened') throw new Error('brak pytania');
    const found = findOpenSubQuestion(registry, opened.question.id, owner);
    t.deepEqual({ name: found?.question.name, text: found?.question.text, task: found?.task }, { name: 'Klara', text: 'Jaki zakres?', task: 'Zestawienie budżetu' });
    t.is(findOpenSubQuestion(registry, undefined, owner), undefined);
    t.is(findOpenSubQuestion(registry, opened.question.id, { ...owner, sessionEpoch: 'e2' }), undefined);
    clock.advance(300000);
    t.is(findOpenSubQuestion(registry, opened.question.id, owner), undefined);
    registry.dispose();
});
class ElementStub {
    children: ElementStub[] = [];
    textContent = '';
    className = '';
    attrs = new Map<string, string>();
    listeners = new Map<string, () => void>();
    classes = new Set<string>();
    classList = { add: (...names: string[]) => names.forEach(n => this.classes.add(n)), remove: (n: string) => this.classes.delete(n), toggle: (n: string, force?: boolean) => { if (force) this.classes.add(n); else this.classes.delete(n); } };
    addClass(name: string) { this.classList.add(name); }
    empty() { this.children = []; this.textContent = ''; }
    appendText(value: string) { this.textContent += value; }
    appendChild(child: ElementStub) { this.children.push(child); return child; }
    createEl(_tag: string, options: { cls?: string; text?: string } = {}) { const child = new ElementStub(); child.className = options.cls || ''; child.textContent = options.text || ''; return this.appendChild(child); }
    createDiv(options = {}) { return this.createEl('div', options); }
    createSpan(options = {}) { return this.createEl('span', options); }
    setAttribute(name: string, value: string) { this.attrs.set(name, value); }
    removeAttribute(name: string) { this.attrs.delete(name); }
    addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
    querySelectorAll() { return []; }
}
const texts = (el: ElementStub): string[] => [el.textContent, ...el.children.flatMap(texts)];

test.serial('bloki czatu pokazują tylko otwarte pytanie właściciela i rozwijają odpowiedź', async t => {
    const hook = `export async function load(url, context, next) { if (url.endsWith('.css')) return { format: 'module', shortCircuit: true, source: 'export default {}' }; return next(url, context); }`;
    register(`data:text/javascript,${encodeURIComponent(hook)}`);
    const { _renderAskUserBlock } = await import('./chat_popovers.js');
    const root = globalThis as unknown as { createDiv: () => ElementStub; document: { createElement: () => ElementStub } };
    const oldCreate = root.createDiv; const oldDocument = root.document;
    root.createDiv = () => new ElementStub(); root.document = { createElement: () => new ElementStub() };
    setLocale('pl');
    const owner = { agentName: 'Jaskier', sessionPath: 's.md', sessionEpoch: 'e1' };
    const clock = new QuestionTestClock(); const registry = new SubTaskRegistry({ questionClock: clock });
    registry.create({ id: 'r1', threadId: 's1', name: 'Klara', origin: owner, taskPreview: 'Budżet' });
    const opened = registry.openParentQuestion('r1', 'Jaki zakres?');
    if (opened.kind !== 'opened') throw new Error('brak pytania');
    const channels = createAskUserChannels(registry);
    const view = { plugin: { subTaskRegistry: registry, showCrystalNotice() {} } };
    const render = (id: string | undefined, channelOwner = owner) => _renderAskUserBlock.call(view as never, { arguments: { question: 'Proszę o odpowiedź', question_id: id } }, new ElementStub() as never, channels.open(channelOwner)) as unknown as ElementStub;
    const block = render(opened.question.id);
    t.true(texts(block).includes('Pytanie od Klara')); t.true(texts(block).includes('Jaki zakres?')); t.true(texts(block).includes('zadanie: Budżet'));
    t.false(texts(render(undefined)).includes('Pytanie od Klara'));
    t.false(texts(render(opened.question.id, { ...owner, sessionEpoch: 'e2' })).includes('Pytanie od Klara'));
    registry.cancelParentQuestion('r1');
    t.false(texts(render(opened.question.id)).includes('Pytanie od Klara'));
    const saved = answeredSubQuestion({ name: 'Klara', question: 'Jaki zakres?', answer: 'Cały.' });
    if (!saved) throw new Error('brak zapisanej odpowiedzi');
    const tile = renderAnsweredSubQuestion(saved) as unknown as ElementStub;
    t.true(tile.classes.has('cs-tile--attention'));
    t.false(tile.classes.has('cs-tile--ok'));
    t.true(texts(tile).includes('Klara zapytał, odpowiedziałem'));
    t.true(tile.children[1].attrs.has('hidden'));
    tile.children[0].listeners.get('click')?.();
    t.false(tile.children[1].attrs.has('hidden')); t.true(texts(tile).includes('Jaki zakres?\n\nCały.'));
    registry.dispose(); setLocale('en'); root.createDiv = oldCreate; root.document = oldDocument;
});
