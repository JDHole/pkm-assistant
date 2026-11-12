import type { CaptureRect } from './index.js';
import { OBSIDIAN_APP_SCREENSHOT_MAX_BYTES, OBSIDIAN_APP_SCREENSHOT_MAX_EDGE } from '../../config/limits.js';

export type CapturedFrame = unknown;
export interface CapturePort { capture(rect: CaptureRect): Promise<CapturedFrame> }

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

/** Validate the desktop API once at the Electron boundary; missing APIs are optional. */
export function createCapturePort(loadElectron: () => unknown): CapturePort | null {
    try {
        const electron = loadElectron();
        if (!record(electron) || !record(electron.remote) || typeof electron.remote.getCurrentWebContents !== 'function') return null;
        const getContents = electron.remote.getCurrentWebContents as () => unknown;
        const contents = getContents.call(electron.remote);
        if (!record(contents) || typeof contents.capturePage !== 'function') return null;
        const capturePage = contents.capturePage as (rect: CaptureRect) => Promise<unknown>;
        return { capture: rect => {
            if (![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) throw new Error('Invalid capture rectangle');
            return capturePage.call(contents, rect);
        } };
    } catch { return null; }
}

interface NativeFrame {
    getSize(): unknown;
    resize(options: { width: number; height: number }): unknown;
    toJPEG(quality: number): unknown;
}
function nativeFrame(value: unknown): value is NativeFrame {
    return record(value) && typeof value.getSize === 'function' && typeof value.resize === 'function' && typeof value.toJPEG === 'function';
}
export async function encodeCapture(raw: CapturedFrame): Promise<{ mime: 'image/jpeg'; base64: string; width: number; height: number } | null> {
    if (!nativeFrame(raw)) throw new Error('Invalid frame');
    const size = raw.getSize();
    if (!record(size) || typeof size.width !== 'number' || typeof size.height !== 'number' || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width <= 0 || size.height <= 0) throw new Error('Invalid size');
    const scale = Math.min(1, OBSIDIAN_APP_SCREENSHOT_MAX_EDGE / Math.max(size.width, size.height));
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    const frame = scale < 1 ? raw.resize({ width, height }) : raw;
    if (!nativeFrame(frame)) throw new Error('Invalid resized frame');
    let bytes = frame.toJPEG(85);
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('Invalid JPEG');
    if (bytes.length > OBSIDIAN_APP_SCREENSHOT_MAX_BYTES) bytes = frame.toJPEG(60);
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('Invalid JPEG');
    if (bytes.length > OBSIDIAN_APP_SCREENSHOT_MAX_BYTES) return null;
    return { mime: 'image/jpeg', base64: Buffer.from(bytes).toString('base64'), width, height };
}
