/**
 * SvgHelper - Converts SVG strings from Crystal Soul generators to DOM elements.
 */
/**
 * Convert hex color (#RRGGBB) to an RGB triplet string "R, G, B" for CSS rgba().
 * @param {string} hex - Color in #RRGGBB format
 * @returns {string} "R, G, B"
 */
export function hexToRgbTriplet(hex: string): string {
  const h = (hex || '#999999').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `${r}, ${g}, ${b}`;
}

/**
 * K11 (AUD-security-090, twardnienie) — kolor wchodzący do MARKUPU SVG.
 *
 * Generatory sklejają SVG stringiem (`fill="${color}"`), a kolor bierze się z pliku profilu
 * agenta w vaultcie. Wartość z cudzysłowem zamykała atrybut i pozwalała dopisać własny
 * element (np. `<image href="https://...">`, który po dołączeniu do DOM-u strzela żądaniem
 * na obcy serwer). Źródło jest dziś zamknięte (`.pkm-assistant/**` fail-closed dla narzędzi
 * bez `admin_access`, UI zapisuje hex z palety), więc to twardnienie, nie łata dziury —
 * ale sklejanie cudzej wartości do markupu bez sprawdzenia nie ma prawa zostać.
 *
 * Przepuszczamy WYŁĄCZNIE kształty, które realnie występują w profilach i skinach:
 * `#rgb`/`#rrggbb`/`#rrggbbaa`, `rgb()`/`rgba()`/`hsl()`/`hsla()`, `var(--nazwa)`,
 * `currentColor`, `none`, `transparent` i gołe nazwy CSS. Reszta → `currentColor`.
 */
export function sanitizeSvgColor(color: unknown, fallback = 'currentColor'): string {
  const raw = typeof color === 'string' ? color.trim() : '';
  if (!raw || raw.length > 64) return fallback;
  const OK = [
    /^#[0-9a-f]{3}$/i,
    /^#[0-9a-f]{6}$/i,
    /^#[0-9a-f]{8}$/i,
    /^(?:rgb|rgba|hsl|hsla)\([0-9a-z%.,\s/+-]*\)$/i,
    /^var\(--[a-z0-9-]+\)$/i,
    /^[a-z]+$/i,
  ];
  return OK.some(re => re.test(raw)) ? raw : fallback;
}

export class SvgHelper {
  /**
   * Parse an SVG string into an SVGElement.
   * @param {string} svgString - Complete <svg>...</svg> markup
   * @returns {SVGElement}
   */
  static toElement(svgString: string): SVGElement {
    const parser = new DOMParser();
    // XML parsing (unlike innerHTML's HTML parser) puts elements in the NULL
    // namespace when the root <svg> lacks xmlns= — the browser then keeps them
    // in the DOM (selectors work) but never renders them as graphics. Generators
    // emit xmlns; hand-written templates (e.g. the token donut) may not.
    let str = svgString;
    if (!/\bxmlns\s*=/.test(str)) {
      str = str.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    const doc = parser.parseFromString(str, 'image/svg+xml');
    const root = doc.documentElement;
    SvgHelper._scrub(root);
    return root as unknown as SVGElement;
  }

  /**
   * Strip executable content from parsed SVG. Plugin generators never emit
   * any of this, so it only matters when markup arrives from user data
   * (e.g. skill icons in YAML, shared skins): DOMParser is inert, but once
   * the element is appended to the live DOM, `onload=` handlers would fire.
   */
  static _scrub(el: Element): void {
    for (const attr of [...(el.attributes || [])]) {
      const name = attr.name.toLowerCase();
      // K11 (AUD-security-090): KAŻDY zdalny adres wylatuje, nie tylko `javascript:`.
      // `<image href="https://...">` w żywym DOM-ie strzela żądaniem na obcy serwer
      // (potwierdzenie, że user otworzył widok) — to też jest wykonanie cudzej treści.
      const isLink = name === 'href' || name === 'xlink:href' || name === 'src';
      if (name.startsWith('on') || (isLink && !/^\s*#/.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
    for (const child of [...(el.children || [])]) {
      const tag = (child.tagName || '').toLowerCase();
      // K11: `image` i `use` ściągają zasoby; `iframe`/`object`/`embed`/`animate` (SMIL
      // umie ustawić dowolny atrybut) dołożone tym samym ruchem — generatory pluginu
      // nie emitują żadnego z nich, więc cięcie nie ma czego zepsuć.
      if (SvgHelper._FORBIDDEN_TAGS.has(tag)) { child.remove(); continue; }
      SvgHelper._scrub(child);
    }
  }

  /** K11: elementy, których markup pluginu nigdy nie emituje, a które wykonują cudzą treść. */
  static _FORBIDDEN_TAGS: ReadonlySet<string> = new Set([
    'script', 'foreignobject', 'image', 'use', 'iframe', 'object', 'embed',
    'animate', 'animatetransform', 'animatemotion', 'set',
  ]);
}
