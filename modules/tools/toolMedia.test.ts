import test from 'ava';
import { asToolMedia, mediaTextPart, toToolMessageContent } from './toolMedia.js';

test('generate_image przekazuje obraz i opis zależnie od vision', t => {
    const raw = { success: true, path: 'a.png', format: 'png', base64: 'QUJD' };
    const media = asToolMedia('generate_image', raw);
    if (!media) return t.fail('Brak mediów');
    const textPart = mediaTextPart('generate_image', raw);
    t.deepEqual(toToolMessageContent(media, { vision: true, textPart }), [
        { type: 'text', text: '{"success":true,"path":"a.png","format":"png"}' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
    t.is(toToolMessageContent(media, { vision: false, textPart }), '{"success":true,"path":"a.png","format":"png","image_delivery":"not delivered: model without vision"}');
    t.deepEqual(raw, { success: true, path: 'a.png', format: 'png', base64: 'QUJD' });
});

test('kontrakt media zachowuje opis i wymiary bez base64', t => {
    const raw = { kind: 'media' as const, summary: 's', images: [{ mime: 'image/jpeg', base64: 'QUJD', width: 2, height: 1 }] };
    const media = asToolMedia('x', raw);
    if (!media) return t.fail('Brak mediów');
    t.is(media, raw);
    t.deepEqual(toToolMessageContent(media, { vision: true, textPart: mediaTextPart('x', raw) }), [
        { type: 'text', text: '{"kind":"media","summary":"s","images":[{"mime":"image/jpeg","width":2,"height":1}]}' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
    ]);
});

test('odrzuca wyniki bez prawidłowych obrazów', t => {
    t.is(asToolMedia('read', { content: 'x' }), null);
    t.is(asToolMedia('generate_image', { success: false }), null);
    t.is(asToolMedia('x', { kind: 'media', summary: 's', images: [] }), null);
    t.is(asToolMedia('x', { kind: 'media', summary: 's', images: [{ mime: 'text/html', base64: 'QUJD' }] }), null);
});

test('MIME obrazu odpowiada zakresowi redakcji', t => {
    for (const mime of ['image/x_png', 'image/png;charset=utf-8']) {
        t.is(asToolMedia('x', { kind: 'media', images: [{ mime, base64: 'QUJD' }] }), null);
        // generate_image nie może spaść do surowego JSON z base64 - nieprawidłowy format daje png.
        t.deepEqual(asToolMedia('generate_image', { format: mime.slice(6), base64: 'QUJD' })?.images, [{ mime: 'image/png', base64: 'QUJD' }]);
    }
    for (const mime of ['image/svg+xml', 'image/vnd.ms-photo']) {
        t.not(asToolMedia('x', { kind: 'media', images: [{ mime, base64: 'QUJD' }] }), null);
    }
});

test('opis redaguje data-URL z escapowanymi ukośnikami', t => {
    t.deepEqual(mediaTextPart('x', { note: 'data:image\\/png;base64,QUJD\\/QUJD koniec' }),
        { note: '[image image/png] koniec' });
});

test('usuwa binarkę z opisu i odrzuca nieprawidłowe wymiary', t => {
    const raw = { kind: 'media', summary: 's', base64: 'QUJD', nested: { base64: 'QUJD', url: 'data:image/png;base64,QUJD' }, images: [{ mime: 'image/png', base64: 'QUJD' }] };
    const media = asToolMedia('x', raw);
    if (!media) return t.fail('Brak mediów');
    const textPart = mediaTextPart('x', raw);
    t.deepEqual(textPart, { kind: 'media', summary: 's', nested: { url: '[image image/png]' }, images: [{ mime: 'image/png' }] });
    const vision = toToolMessageContent(media, { vision: true, textPart });
    t.deepEqual(vision, [{ type: 'text', text: '{"kind":"media","summary":"s","nested":{"url":"[image image/png]"},"images":[{"mime":"image/png"}]}' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }]);
    t.is(toToolMessageContent(media, { vision: false, textPart }), '{"kind":"media","summary":"s","nested":{"url":"[image image/png]"},"images":[{"mime":"image/png"}],"image_delivery":"not delivered: model without vision"}');
    for (const width of [{}, 0, Infinity, undefined]) t.is(asToolMedia('x', { kind: 'media', summary: 's', images: [{ mime: 'image/png', base64: 'QUJD', width }] }), null);
    t.is(asToolMedia('x', { kind: 'media', summary: 's', images: [{ mime: 'image/png', base64: 'QUJD', height: 0 }] }), null);
    t.is(asToolMedia('generate_image', { kind: 'media', summary: 's', base64: 'QUJD', images: [{ mime: 'image/png', base64: 'QUJD', width: 0 }] }), null);
    t.deepEqual(asToolMedia('generate_image', { base64: 'QUJD', format: {} })?.images, [{ mime: 'image/png', base64: 'QUJD' }]);
});

test('opis uwzględnia toJSON, daty i tekst po data-URL', t => {
    const raw = {
        kind: 'media', summary: 's', meta: { toJSON() { return { base64: 'QUJD' }; } },
        images: [{ mime: 'image/png', base64: 'QUJD' }],
        note: 'data:image/png;base64,QUJD\nOCR total: 123 PLN', when: new Date('2026-11-12T00:00:00.000Z'),
    };
    const textPart = mediaTextPart('x', raw);
    t.deepEqual(textPart, { kind: 'media', summary: 's', meta: {}, images: [{ mime: 'image/png' }], note: '[image image/png]\nOCR total: 123 PLN', when: '2026-11-12T00:00:00.000Z' });
    t.false(JSON.stringify(textPart).includes('QUJD'));
});
