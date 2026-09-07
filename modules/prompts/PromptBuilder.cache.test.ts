import test from 'ava';
import fs from 'node:fs';

test('PromptBuilder keeps _buildIdentity free from date generation', t => {
const source = fs.readFileSync(new URL('./PromptBuilder.ts', import.meta.url), 'utf8');
    const identityBody = source.match(/_buildIdentity\(agent, ctx\) \{([\s\S]*?)\n    \}/)?.[1] || '';

    t.false(identityBody.includes('new Date'));
    t.true(source.includes("_add('current_date'"));
    t.true(source.includes('_buildCurrentDate'));
});
