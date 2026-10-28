/** Remove the exact leading note and its separator, once. */
export function stripRunnerQuestion(material: string, note?: string): string {
    if (!note || !material.startsWith(note)) return material;
    return material.slice(note.length).replace(/^(?:\r?\n[\t ]*)+/, '');
}
