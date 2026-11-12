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
