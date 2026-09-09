import test from 'ava';
import { openaiProvider } from './openai.js';
import { t, setLocale } from '../../../core/i18n/index.js';
import { makeCtx } from '../testing/harness.js';
import type { OpenAiRequestMessage } from '../contracts.js';

/**
 * Budowa żądania podmienia treść wiadomości złożonej z samego obrazu na komunikat
 * o braku wsparcia dla vision. Ten tekst wchodzi do transkryptu WIDZIANEGO przez model
 * (i do zapisu sesji) - idzie przez `t('model.image_stripped')`, więc respektuje
 * `settings.language` tak jak reszta komunikatów, zamiast być zaszytym stringiem.
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

test('obraz pominięty na non-vision modelu idzie przez t(\'model.image_stripped\'), nie przez zaszyty string', t2 => {
  setLocale('en');
  const [msg] = transform(imageOnlyMessage);
  t2.is(msg.content, t('model.image_stripped'));
  t2.not(msg.content, '[Obraz pominiety — model nie obsluguje vision]', 'dawny zaszyty polski string (bez ogonków) ma zniknąć');
});

test('komunikat respektuje locale usera (pl vs en to różny tekst)', t2 => {
  setLocale('en');
  const [en] = transform(imageOnlyMessage);
  setLocale('pl');
  const [pl] = transform(imageOnlyMessage);

  t2.not(en.content, pl.content, 'zmiana locale ma zmienić tekst — inaczej to dalej zaszyty string');
  t2.is(pl.content, 'Obraz pominięty — model nie obsługuje vision.');
});

/**
 * Wiadomość MIESZANA (tekst + obraz) na modelu bez vision traci TYLKO blok obrazu -
 * tekst zostaje, wysyłka nie jest blokowana.
 */
test('wiadomość MIESZANA (tekst + obraz) na modelu bez vision traci tylko obraz', t2 => {
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
 * Na modelu Z vision obraz przechodzi nietknięty.
 */
test('na modelu z vision obraz przechodzi nietknięty', t2 => {
  setLocale('en');
  const [msg] = transform(imageOnlyMessage, 'gpt-4o');
  const asText = JSON.stringify(msg.content);

  t2.true(asText.includes('image_url'), 'blok image_url ma zostać w żądaniu');
  t2.true(asText.includes('base64,QUJD'), 'dane obrazu mają przejść bez zmian');
  t2.false(asText.includes(t('model.image_stripped')), 'na modelu vision nie ma czego pomijać');
});
