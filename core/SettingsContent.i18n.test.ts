/**
 * Strażnik po źródle dla AUD-code-review-034 — blok „Secure storage" i „Approved actions"
 * w `core/SettingsContent.ts` omijał `core/i18n` mimo że reszta pliku idzie przez `t()`.
 *
 * Naprawiono 7 napisów: nazwa + opis przełącznika Secure storage, dwa `Notice` migracji,
 * nagłówek „Approved actions", „No rules saved yet." i guzik „Remove".
 *
 * Plik faktycznie WSTAJE w Node (tylko `import type` na `obsidian`), ale funkcje eksportowane
 * przyjmują `container: HTMLElement` z metodami Obsidiana (`createEl`/`createDiv`) których nie ma
 * w gołym Node bez DOM-a (repo nie ma jsdom w AVA) — więc pilnujemy po ŹRÓDLE, wzorem
 * `modules/shell/MCPServerEditorModal.rollback.test.ts`.
 */
import test from 'ava';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const source = readFileSync(fileURLToPath(new URL('./SettingsContent.ts', import.meta.url)), 'utf8');

test('renderApiKeysSection: przełącznik Secure storage idzie przez t() (AUD-code-review-034)', t => {
    t.notRegex(source, /\.setName\('Secure storage'\)/);
    t.notRegex(source, /\.setDesc\(`Stores API keys as secret references/);
    t.regex(source, /\.setName\(t\('settings\.secure_storage_name'\)\)/);
    t.regex(source, /\.setDesc\(t\('settings\.secure_storage_desc', \{ backend: secrets\.backend \}\)\)/);
});

test('renderApiKeysSection: oba Notice migracji idą przez t() (AUD-code-review-034)', t => {
    t.notRegex(source, /new Notice\('Secure storage: migration cancelled\.'\)/);
    t.notRegex(source, /new Notice\('API keys migrated to secure storage references\.'\)/);
    t.regex(source, /new Notice\(t\('settings\.secure_storage_migration_cancelled'\)\)/);
    t.regex(source, /new Notice\(t\('settings\.secure_storage_migrated'\)\)/);
});

test('renderNoGoSection: "Approved actions" / "No rules saved yet." / "Remove" idą przez t() (AUD-code-review-034)', t => {
    t.notRegex(source, /createEl\('h3', \{ text: 'Approved actions' \}\)/);
    t.notRegex(source, /text: 'No rules saved yet\.'/);
    t.notRegex(source, /setButtonText\('Remove'\)/);
    // release 2.2.0/W1: nagłówek h3 → Setting().setName().setHeading() (obsidianmd/no-manual-html-headings),
    // wzorzec zmieniony, ale nadal idzie przez t() — to jest sedno tego testu.
    t.regex(source, /setName\(t\('settings\.approved_actions_title'\)\)\.setHeading\(\)/);
    t.regex(source, /text: t\('settings\.approved_actions_empty'\)/);
    t.regex(source, /setButtonText\(t\('settings\.approved_actions_remove'\)\)/);
});
