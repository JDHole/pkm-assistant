export type InlineTriggerType = 'skill' | 'tool' | 'sub-agent';
export type InlineTrigger = { type: InlineTriggerType; name: string; raw: string; index: number };
type ResolvedSkill = { name?: string; prompt?: string };

const MARKER_PATTERNS: Array<{ type: InlineTriggerType; regex: RegExp }> = [
    { type: 'skill', regex: /@@skill:([A-Za-z0-9_.-]+)(?:@@)?/g },
    { type: 'tool', regex: /@@tool:([A-Za-z0-9_.-]+)(?:@@)?/g },
    { type: 'sub-agent', regex: /@sub-agent:([A-Za-z0-9_.-]+)/g },
    { type: 'sub-agent', regex: /@agent:([A-Za-z0-9_.-]+)/g },
];

export function parseInlineTriggers(text = ''): InlineTrigger[] {
    const markers: InlineTrigger[] = [];
    for (const { type, regex } of MARKER_PATTERNS) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            markers.push({
                type,
                name: match[1],
                raw: match[0],
                index: match.index,
            });
        }
    }
    return markers.sort((a, b) => a.index - b.index);
}

export function stripInlineTriggers(text = ''): string {
    return MARKER_PATTERNS.reduce((acc, { regex }) => acc.replace(regex, '').replace(/\s{2,}/g, ' '), text).trim();
}

/**
 * Zbuduj instrukcję tury z markerów inline.
 *
 * D17 (E2.4): skille nie mają już narzędzia skill_execute. Marker `@@skill:` wstrzykuje
 * PEŁNY przepis zresolwowanego skilla (z overridami per-agent — „doczepki nie giną").
 * Resolucja jest async/plugin-zależna, więc robi ją chat_streaming i podaje tu gotową mapę
 * `resolvedSkills` (nazwa/slug markera → { name?, prompt }). Marker bez wpisu (nieznany skill)
 * → krótka nota, bez wybuchu. Sub-agent/tool bez zmian.
 *
 * @param {Array<{type:string, name:string}>} markers
 * @param {Object<string, {name?:string, prompt?:string}>} [resolvedSkills] - przepisy skilli po nazwie markera
 * @returns {string}
 */
export function buildInlineTriggerInstruction(
    markers: Array<Pick<InlineTrigger, 'type' | 'name'>> = [],
    resolvedSkills: Record<string, ResolvedSkill> = {},
): string {
    if (!markers.length) return '';
    const lines = [
        'INLINE TRIGGERS:',
        'User explicitly inserted trigger chips in this message. Treat them as direct instructions for this message only.',
    ];
    const recipeBlocks = [];
    for (const marker of markers) {
        if (marker.type === 'sub-agent') {
            lines.push(`- Force delegate first: call delegate with aspect="${marker.name}" and aspect_explicit=true.`);
        } else if (marker.type === 'skill') {
            const resolved = resolvedSkills[marker.name];
            if (resolved && resolved.prompt) {
                const skillName = resolved.name || marker.name;
                lines.push(`- Skill "${skillName}": wykonaj przepis wklejony niżej (bez pytania).`);
                recipeBlocks.push(
                    `=== UŻYTKOWNIK URUCHOMIŁ SKILL "${skillName}" — wykonaj poniższy przepis (bez pytania): ===\n` +
                    `${resolved.prompt}\n` +
                    `=== koniec przepisu "${skillName}" ===`
                );
            } else {
                lines.push(`- Skill "${marker.name}" nie znaleziony — pomiń albo znajdź go w indeksie skilli i wczytaj przepis przez read().`);
            }
        } else if (marker.type === 'tool') {
            lines.push(`- Force tool: call "${marker.name}" before answering if its required arguments can be inferred from the user message.`);
        }
    }
    return [lines.join('\n'), ...recipeBlocks].join('\n\n');
}

export function makeInlineTriggerMarker(type: InlineTriggerType, name: string): string {
    if (type === 'skill') return `@@skill:${name}`;
    if (type === 'tool') return `@@tool:${name}`;
    return `@sub-agent:${name}`;
}

export function insertInlineTriggerMarker(
    textarea: HTMLTextAreaElement | null | undefined,
    type: InlineTriggerType,
    name: string,
): void {
    if (!textarea) return;
    const marker = makeInlineTriggerMarker(type, name);
    const value = textarea.value || '';
    const start = textarea.selectionStart ?? value.length;
    const end = textarea.selectionEnd ?? value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const prefix = before && !/\s$/.test(before) ? ' ' : '';
    const suffix = after && !/^\s/.test(after) ? ' ' : ' ';
    textarea.value = `${before}${prefix}${marker}${suffix}${after}`;
    const cursor = before.length + prefix.length + marker.length + suffix.length;
    textarea.setSelectionRange(cursor, cursor);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.focus();
}

export function getInlineTriggerSummary(markers: Array<Pick<InlineTrigger, 'type' | 'name'>> = []): string {
    return markers.map(marker => `${marker.type}:${marker.name}`).join(', ');
}

