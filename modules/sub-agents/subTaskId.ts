let sequence = 0;
const processTag = crypto.randomUUID().replace(/-/g, '').slice(0, 8);

/** Unikalny identyfikator biegu i wątku suba w tym procesie. */
export function allocateSubTaskId(name: string): string {
    return `sub/${name || 'sub'}#${processTag}-${(++sequence).toString(36)}`;
}
