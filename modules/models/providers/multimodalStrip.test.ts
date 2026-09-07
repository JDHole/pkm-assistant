import test from 'ava';
import { openaiProvider } from './openai.js';
import { t, setLocale } from '../../../core/i18n/index.js';
import { makeCtx } from '../testing/harness.js';
import type { OpenAiRequestMessage } from '../contracts.js';

/**
 * AUD-code-review-021 (LOW): budowa żądania podmieniała treść wiadomości złożonej z samego
 * obrazu na zaszyty polski string `'[Obraz pominiety — model nie obsluguje vision]'` (bez
 * ogonków), mimo że rodzina komunikatów o braku vision (`chat.streaming.model_no_vision` /
 * `oczko_no_vision`) ma klucze w `core/i18n`. Ten tekst wchodzi do transkryptu WIDZIANEGO
 * przez model (i do zapisu sesji) — dziś idzie przez `t('model.image_stripped')`, więc
 * respektuje `settings.language` tak jak reszta komunikatów. (B.6 BA-15/BA-16)
 */
function transform(messages: OpenAiRequestMessage[], modelKey = 'llama3'): OpenAiRequestMessage[] {
  const spec = openaiProvider.buildRequest({ model: modelKey, messages }, makeCtx({ modelId: modelKey }), false);
  return (JSON.parse(spec.body ?? '{}') as { messages: OpenAiRequestMessage[] }).messages;
}

const imageOnlyMessage: OpenAiRequestMessage[] = [{
  role: 'user',
  content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }],
}];

test.afterEach(() => { setLocale('en'); });

test('021: obraz pominięty na non-vision modelu idzie przez t(\'model.image_stripped\'), nie przez zaszyty string', t2 => {
  setLocale('en');
  const [msg] = transform(imageOnlyMessage);
  t2.is(msg.content, t('model.image_stripped'));
  t2.not(msg.content, '[Obraz pominiety — model nie obsluguje vision]', 'dawny zaszyty polski string (bez ogonków) ma zniknąć');
});

test('021: komunikat respektuje locale usera (pl vs en to różny tekst)', t2 => {
  setLocale('en');
  const [en] = transform(imageOnlyMessage);
  setLocale('pl');
  const [pl] = transform(imageOnlyMessage);

  t2.not(en.content, pl.content, 'zmiana locale ma zmienić tekst — inaczej to dalej zaszyty string');
  t2.is(pl.content, 'Obraz pominięty — model nie obsługuje vision.');
});

/**
 * N23 (luka L-10, B.6 BA-15): wiadomość MIESZANA (tekst + obraz) na modelu bez vision
 * traci TYLKO blok obrazu — tekst zostaje, wysyłka nie jest blokowana.
 */
test('L-10: wiadomość MIESZANA (tekst + obraz) na modelu bez vision traci tylko obraz', t2 => {
  setLocale('en');
  const mixed: OpenAiRequestMessage[] = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Co jest na tym obrazku?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ],
  }];

  const [msg] = transform(mixed, 'llama3');
  const asText = JSON.stringify(msg.content);

  t2.true(asText.includes('Co jest na tym obrazku?'), 'tekst usera MUSI przejść');
  t2.false(asText.includes('base64,QUJD'), 'blok obrazu ma zniknąć z żądania');
  t2.true(asText.includes(t('model.image_stripped')), 'w miejsce obrazu wchodzi komunikat i18n');
});

/**
 * N24 (luka L-10, B.13 VC-01): na modelu Z vision obraz przechodzi nietknięty.
 */
test('L-10: na modelu z vision obraz przechodzi nietknięty', t2 => {
  setLocale('en');
  const [msg] = transform(imageOnlyMessage, 'gpt-4o');
  const asText = JSON.stringify(msg.content);

  t2.true(asText.includes('image_url'), 'blok image_url ma zostać w żądaniu');
  t2.true(asText.includes('base64,QUJD'), 'dane obrazu mają przejść bez zmian');
  t2.false(asText.includes(t('model.image_stripped')), 'na modelu vision nie ma czego pomijać');
});
