/**
 * AUD-wydajnosc-096: blok myśli dopisuje DELTĘ zamiast podmieniać całość.
 *
 * `updateThinkingBlock` dostaje ślad rozumowania ZAKUMULOWANY od początku tury (adapter
 * dokłada deltę do `message.reasoning_content`), więc `content.textContent = text` przy każdym
 * wywołaniu przepisywało O(K × długość) znaków i przy rozwiniętym bloku wymuszało przeliczenie
 * układu (`scrollHeight`) — także wtedy, gdy nic się nie zmieniło.
 *
 * `createThinkingBlock` wymaga rozszerzeń DOM Obsidiana (`createDiv`), więc testujemy samą
 * funkcję aktualizującą na atrapie elementu — tego wymaga też `modules/ui-components/CLAUDE.md`
 * („dotykasz czegokolwiek tutaj → dopisz test przy okazji").
 */
import test from 'ava';
import { updateThinkingBlock } from './ThinkingBlock.js';

// TS-any: atrapa węzła DOM — liczy zapisy, nie udaje pełnego Elementu.
type FakeAny = any;

function fakeBlock(open = false) {
    const content: FakeAny = {
        _text: '',
        appends: 0,
        appendedChars: 0,
        fullWrites: 0,
        writtenChars: 0,
        layoutReads: 0,
        scrollTop: 0,
        get textContent() { return this._text; },
        set textContent(value: string) { this._text = value; this.fullWrites++; this.writtenChars += value.length; },
        append(chunk: string) { this._text += chunk; this.appends++; this.appendedChars += chunk.length; },
        get scrollHeight() { this.layoutReads++; return 1000; },
    };
    const block: FakeAny = {
        classList: { contains: (cls: string) => cls === 'open' && open },
        querySelector: () => content,
    };
    return { block, content };
}

test('rosnący ślad rozumowania dopisuje deltę, nie przepisuje całości', t => {
    const { block, content } = fakeBlock();

    let text = '';
    for (let i = 0; i < 200; i++) {
        text += 'rozumowanie ';
        updateThinkingBlock(block, text);
    }

    t.is(content.textContent, text, 'treść na ekranie musi być identyczna z zakumulowanym śladem');
    t.is(content.fullWrites, 1, 'pełne przepisanie tylko raz — przy pierwszym wywołaniu');
    t.is(content.appends, 199);
    // Liniowo, nie kwadratowo: przepisane znaki ≈ długość finalnego tekstu, a nie K × długość.
    const total = content.writtenChars + content.appendedChars;
    t.is(total, text.length);
    t.true(total < 200 * text.length / 10, `przepisano ${total} znaków — to nadal kwadrat`);
});

test('identyczny tekst = zero zapisów i zero wymuszonych przeliczeń układu', t => {
    const { block, content } = fakeBlock(true); // blok ROZWINIĘTY — tu boli `scrollHeight`
    updateThinkingBlock(block, 'ślad rozumowania');
    const writesAfterFirst = content.fullWrites + content.appends;
    const layoutAfterFirst = content.layoutReads;

    for (let i = 0; i < 3000; i++) updateThinkingBlock(block, 'ślad rozumowania');

    t.is(content.fullWrites + content.appends, writesAfterFirst, 'żadnego dodatkowego zapisu');
    t.is(content.layoutReads, layoutAfterFirst, 'żadnego dodatkowego odczytu scrollHeight');
});

test('rollback / podmiana treści = pełne przepisanie (nie doklejamy śmieci)', t => {
    const { block, content } = fakeBlock();
    updateThinkingBlock(block, 'pierwsza wersja rozumowania');
    updateThinkingBlock(block, 'zupełnie inna treść');

    t.is(content.textContent, 'zupełnie inna treść');
    t.is(content.fullWrites, 2);
    t.is(content.appends, 0);
});

test('rozwinięty blok nadal dojeżdża na dół po REALNEJ zmianie', t => {
    const { block, content } = fakeBlock(true);
    updateThinkingBlock(block, 'a');
    updateThinkingBlock(block, 'ab');
    t.is(content.layoutReads, 2, 'auto-scroll zachowany dla każdej zmiany treści');
    t.is(content.scrollTop, 1000);
});

test('zwinięty blok nie czyta scrollHeight w ogóle', t => {
    const { block, content } = fakeBlock(false);
    updateThinkingBlock(block, 'a');
    updateThinkingBlock(block, 'ab');
    t.is(content.layoutReads, 0);
});
