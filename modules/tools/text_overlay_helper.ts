/**
 * text_overlay_helper.js — Sprint 04 Z7 (MCP_PORZADEK_v1).
 *
 * `renderTextOverlay()` — czysta funkcja Canvas2D (bez modala, bez UI), używana przez
 * `add_text_to_image`. Wydzielona z narzędzia, żeby dało się ją testować i wołać
 * bez wciągania warstwy widoków.
 */

/**
 * Parametry napisu nakładanego na obraz — kształt JUŻ ROZWIĄZANY.
 *
 * ⚠️ Ten plik NIE stosuje domyślnych wartości: defaulty (`fontSize=32`, `color='#ffffff'`,
 * `position='bottom-left'` itd.) wstawia wołacz — `add_text_to_image` przy destrukturyzacji
 * argumentów. Dawny JSDoc opisywał je tutaj jako „[style.fontSize=32]", co było nieprawdą:
 * brak pola dawał `NaN`/`undefined` w atrybutach kontekstu, a nie wartość domyślną.
 */
export interface TextOverlayStyle {
    /** tekst do nałożenia */
    text: string;
    /**
     * Etykieta pozycji: `top-left` | `top-center` | `top-right` | `center` |
     * `bottom-left` | `bottom-center` | `bottom-right` | `custom` (bierze `x`/`y`
     * w pikselach). Typ jest celowo szeroki (`string`): etykieta przychodzi od
     * MODELU, a nieznana wartość spada na `bottom-left` w lookupie niżej, zamiast
     * wywalać render.
     */
    position: string;
    /** tylko gdy position=custom */
    x: number | null;
    /** tylko gdy position=custom */
    y: number | null;
    fontSize: number;
    fontFamily: string;
    color: string;
    shadow: boolean;
    shadowColor: string;
    bold: boolean;
    italic: boolean;
    outline: boolean;
    outlineColor: string;
    outlineWidth: number;
}

/**
 * Renderuje tekst na obrazie za pomocą OffscreenCanvas (Electron).
 * @param imageData — binarny obraz
 * @param style — parametry tekstu
 * @returns wynikowy PNG jako ArrayBuffer
 */
export async function renderTextOverlay(imageData: ArrayBuffer, style: TextOverlayStyle): Promise<ArrayBuffer> {
    const blob = new Blob([imageData]);
    const imageBitmap = await createImageBitmap(blob);

    const w = imageBitmap.width;
    const h = imageBitmap.height;

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;

    ctx.drawImage(imageBitmap, 0, 0);

    const weight = style.bold ? 'bold' : 'normal';
    const fontStyle = style.italic ? 'italic' : 'normal';
    ctx.font = `${fontStyle} ${weight} ${style.fontSize}px "${style.fontFamily}"`;
    ctx.fillStyle = style.color;
    ctx.textBaseline = 'top';

    const metrics = ctx.measureText(style.text);
    const textWidth = metrics.width;
    const textHeight = style.fontSize * 1.2;
    const padding = style.fontSize * 0.5;

    let posX: number, posY: number;

    if (style.position === 'custom' && style.x != null && style.y != null) {
        posX = style.x;
        posY = style.y;
    } else {
        const positions: Record<string, { x: number; y: number }> = {
            'top-left':      { x: padding, y: padding },
            'top-center':    { x: (w - textWidth) / 2, y: padding },
            'top-right':     { x: w - textWidth - padding, y: padding },
            'center':        { x: (w - textWidth) / 2, y: (h - textHeight) / 2 },
            'bottom-left':   { x: padding, y: h - textHeight - padding },
            'bottom-center': { x: (w - textWidth) / 2, y: h - textHeight - padding },
            'bottom-right':  { x: w - textWidth - padding, y: h - textHeight - padding },
        };
        const pos = positions[style.position] || positions['bottom-left'];
        posX = pos.x;
        posY = pos.y;
    }

    if (style.shadow) {
        ctx.shadowColor = style.shadowColor;
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
    }

    if (style.outline) {
        ctx.strokeStyle = style.outlineColor;
        ctx.lineWidth = style.outlineWidth;
        ctx.lineJoin = 'round';
        ctx.strokeText(style.text, posX, posY);
    }

    ctx.fillText(style.text, posX, posY);

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    imageBitmap.close();

    const resultBlob = await canvas.convertToBlob({ type: 'image/png' });
    return await resultBlob.arrayBuffer();
}
