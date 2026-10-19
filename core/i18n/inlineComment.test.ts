import test from 'ava';
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

async function loadPublicEntries() {
    const obsidianStub = path.join(process.env.PKM_TEST_SUPPORT_DIR || '', 'obsidian.ts');
    const bundle = await esbuild.build({
        stdin: {
            contents: "export {default as Plugin} from './src/main.ts'; export {setLocale} from './core/i18n/index.ts'; export {PromptBuilder} from './modules/prompts/PromptBuilder.ts';",
            resolveDir: process.cwd(), sourcefile: 'inline-comment-entry.ts',
        },
        bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
        plugins: [{ name: 'test-assets', setup(build) {
            build.onResolve({ filter: /^obsidian$/ }, () => ({ path: obsidianStub }));
            build.onResolve({ filter: /\.(css|md)$/ }, args => ({ path: path.resolve(args.resolveDir, args.path), namespace: 'text-asset' }));
            build.onLoad({ filter: /.*/, namespace: 'text-asset' }, args => ({ contents: `export default ${JSON.stringify(fs.readFileSync(args.path, 'utf8'))};`, loader: 'js' }));
        } }],
    });
    type BundleExports = {
        Plugin: { prototype: { sendInlineComment: (file: string, selection: string, comment: string) => void } };
        PromptBuilder: new () => { build(agent: { name: string }, context: object): { getPrompt(): string } };
        setLocale(locale: string): void;
    };
    const bundleModule = { exports: {} as BundleExports };
    const execute = vm.runInThisContext(`(function(require, module, exports) { ${bundle.outputFiles[0].text} })`) as
        (require: NodeRequire, module: { exports: BundleExports }, exports: BundleExports) => void;
    execute(createRequire(import.meta.url), bundleModule, bundleModule.exports);
    return bundleModule.exports;
}

for (const [locale, marker] of [['en', 'INLINE COMMENT'], ['pl', 'KOMENTARZ INLINE']] as const) {
    test.serial(`inline comment sent to chat matches rendered rule in ${locale}`, async t => {
        const { Plugin, PromptBuilder, setLocale } = await loadPublicEntries();
        setLocale(locale);
        const prompt = new PromptBuilder().build({ name: 'Tester' }, {}).getPrompt();
        let sent = '';
        const chatView = {
            input_area: { value: '' },
            send_message() { sent = this.input_area.value; },
        };
        const plugin = Object.create(Plugin.prototype) as Record<string, unknown>;
        plugin.openChatView = () => Promise.resolve();
        plugin.registerInterval = () => 0;
        plugin.app = {
            workspace: { getLeavesOfType: () => [{ view: chatView }] },
        };
        const originalSetTimeout = window.setTimeout;
        window.setTimeout = ((callback: () => void) => { callback(); return 0; }) as typeof window.setTimeout;
        try {
            Plugin.prototype.sendInlineComment.call(plugin, 'Notes/example.md', 'selected', 'change it');
        } finally {
            window.setTimeout = originalSetTimeout;
        }
        t.is(sent.split('\n')[0], marker);
        t.true(prompt.includes(`starts with ${marker}`) || prompt.includes(`zaczyna się od ${marker}`));
        t.false(prompt.includes(`[${marker}]`));
    });
}
