import test from 'ava';
import { validateVaultPath, validateVaultFolder } from './vault_path_validator.js';

test('validateVaultPath: valid relative path', t => {
    const result = validateVaultPath('Notes/foo.md');
    t.true(result.ok);
    t.is(result.safePath, 'Notes/foo.md');
    t.is(result.error, null);
    t.is(result.code, null);
});

test('validateVaultPath: empty path → error code "empty"', t => {
    const result = validateVaultPath('');
    t.false(result.ok);
    t.is(result.code, 'empty');
});

test('validateVaultPath: empty path with allowEmpty=true → ok', t => {
    const result = validateVaultPath('', { allowEmpty: true });
    t.true(result.ok);
    t.is(result.safePath, '');
});

test('validateVaultPath: null/undefined → empty code', t => {
    t.is(validateVaultPath(null).code, 'empty');
    t.is(validateVaultPath(undefined).code, 'empty');
});

test('validateVaultPath: path traversal blocked', t => {
    const result = validateVaultPath('../../etc/passwd');
    t.false(result.ok);
    t.is(result.code, 'invalid_path');
});

test('validateVaultPath: protected path .env blocked', t => {
    const result = validateVaultPath('.env');
    t.false(result.ok);
    t.is(result.code, 'protected');
});

test('validateVaultPath: allowProtected=true overrides protected check', t => {
    const result = validateVaultPath('.env', { allowProtected: true });
    t.true(result.ok);
    t.is(result.safePath, '.env');
});

test('A1 adminAccess otwiera protected i .pkm-assistant, ale traversal nadal blokuje', t => {
    t.true(validateVaultPath('.obsidian/plugins.json', { adminAccess: true }).ok);
    t.true(validateVaultPath('data.json', { adminAccess: true }).ok);
    t.true(validateVaultPath('.pkm-assistant/agents/nika.yaml', { adminAccess: true }).ok);
    t.false(validateVaultPath('../../outside.txt', { adminAccess: true }).ok);
});

test('validateVaultPath: non-string input → invalid_path', t => {
    t.is(validateVaultPath(123).code, 'invalid_path');
    t.is(validateVaultPath({}).code, 'invalid_path');
    t.is(validateVaultPath([]).code, 'invalid_path');
});

test('validateVaultFolder: empty folder defaults to allowEmpty=true', t => {
    const result = validateVaultFolder('');
    t.true(result.ok);
    t.is(result.safePath, '');
});

test('validateVaultFolder: still blocks protected paths', t => {
    const result = validateVaultFolder('.pkm-assistant/logs');
    t.false(result.ok);
    t.is(result.code, 'protected');
});

test('validateVaultPath: .pkm-assistant jest chroniony (pamięci agentów + indeks)', t => {
    const meta = validateVaultPath('.pkm-assistant/index/vault-index.meta.json');
    t.false(meta.ok);
    t.is(meta.code, 'protected');

    const brain = validateVaultPath('.pkm-assistant/agents/jaskier/memory/brain.md');
    t.false(brain.ok);
    t.is(brain.code, 'protected');

    const root = validateVaultPath('.pkm-assistant');
    t.false(root.ok);
    t.is(root.code, 'protected');
});

test('validateVaultPath: podobna nazwa pliku NIE jest łapana przez blokadę .pkm-assistant', t => {
    const result = validateVaultPath('.pkm-assistant-notatka.md');
    t.true(result.ok);
});

// ── Wyjątek TYLKO-ODCZYT dla przepisów skilli ──

test('validateVaultPath: allowSkillsRead pozwala CZYTAĆ przepis skilla', t => {
    const skill = validateVaultPath('.pkm-assistant/skills/daily-review/SKILL.md', { allowSkillsRead: true });
    t.true(skill.ok);
    t.is(skill.safePath, '.pkm-assistant/skills/daily-review/SKILL.md');

    const folder = validateVaultFolder('.pkm-assistant/skills', { allowSkillsRead: true });
    t.true(folder.ok);
});

test('validateVaultPath: BEZ allowSkillsRead skille wciąż zablokowane (write/delete/create_folder)', t => {
    const skill = validateVaultPath('.pkm-assistant/skills/daily-review/SKILL.md');
    t.false(skill.ok);
    t.is(skill.code, 'protected');
});

test('validateVaultPath: allowSkillsRead NIE otwiera pamięci ani indeksu (izolacja nietknięta)', t => {
    // Pamięć innego agenta — nadal zablokowana nawet z flagą.
    const brain = validateVaultPath('.pkm-assistant/agents/jaskier/memory/brain.md', { allowSkillsRead: true });
    t.false(brain.ok);
    t.is(brain.code, 'protected');

    // Indeks semantyczny — nadal zablokowany.
    const index = validateVaultPath('.pkm-assistant/index/vault-index.meta.json', { allowSkillsRead: true });
    t.false(index.ok);
    t.is(index.code, 'protected');

    // Katalog skills-podobny poza skills/ — nadal zablokowany.
    const notSkills = validateVaultPath('.pkm-assistant/skills-secret/x.md', { allowSkillsRead: true });
    t.false(notSkills.ok);
    t.is(notSkills.code, 'protected');
});

// ── Log pluginu i sesje pamięci są „protected" także tutaj ──

test('validateVaultPath odbija log pluginu kodem protected', t => {
    const res = validateVaultPath('.pkm-assistant/logs/pkm-assistant.log');
    t.false(res.ok);
    t.is(res.code, 'protected');
});

test('validateVaultPath odbija plik sesji pamięci agenta kodem protected', t => {
    const res = validateVaultPath('.pkm-assistant/agents/klara/memory/sessions/active/2026-08-22.md');
    t.false(res.ok);
    t.is(res.code, 'protected');
});
