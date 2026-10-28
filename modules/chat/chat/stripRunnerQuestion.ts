import { t } from '../../../core/i18n/index.js';

/** Remove only the runner's leading no-answer paragraph, using the known question. */
export function stripRunnerQuestion(material: string, question: string, translate: typeof t = t): string {
    for (const locale of ['pl', 'en']) {
        const marker = '{{question}}';
        const template = translate('subagent.question_no_answer', { question: marker }, locale);
        const [prefix, suffix] = template.split(marker);
        if (suffix !== '' || !material.startsWith(prefix)) continue;
        const rest = material.slice(prefix.length);
        const boundary = (length: number) => rest.length === length || rest.slice(length, length + 2) === '\n\n';
        for (const candidate of [question, question.trimEnd()]) {
            if (rest.startsWith(candidate) && boundary(candidate.length)) return rest.slice(candidate.length).trimStart();
        }
        // Runner's private _clipText uses slice(0, cap - 1) + '…'; cap varies by settings.
        for (let end = rest.indexOf('…'); end >= 0; end = rest.indexOf('…', end + 1)) {
            if (end < question.length && boundary(end + 1) && question.startsWith(rest.slice(0, end))) {
                return rest.slice(end + 1).trimStart();
            }
        }
    }
    return material;
}
