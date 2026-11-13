import test from 'ava';
import { diagnosticRedactor } from './index.js';

const cases: [string, string][] = [
    ['"kuba"@example.com', '[EMAIL]'],
    ['kuba@example.com', '[EMAIL]'],
    ['"kuba kowalski"@example.com', '[EMAIL]'],
    ['sk-a***WXYZ gith***WXYZ priv***e123', '[REDACTED] [REDACTED] [REDACTED]'],
    ['?key=abc', '?key=[REDACTED]'],
    ['?key=private123', '?key=[REDACTED]'],
    ['?api_key=a&apikey=b&api-key=c', '?api_key=[REDACTED]&apikey=[REDACTED]&api-key=[REDACTED]'],
    ['?token=a&access_token=b&refresh_token=c', '?token=[REDACTED]&access_token=[REDACTED]&refresh_token=[REDACTED]'],
    ['?secret=a&password=b&signature=c', '?secret=[REDACTED]&password=[REDACTED]&signature=[REDACTED]'],
    ['key=abc', '[REDACTED]'],
    ['api_key: a', '[REDACTED]'],
    ['apikey=b', '[REDACTED]'],
    ['api-key=c', '[REDACTED]'],
    ['token=d', '[REDACTED]'],
    ['access_token=e', '[REDACTED]'],
    ['refresh_token=f', '[REDACTED]'],
    ['secret=g', '[REDACTED]'],
    ['password=h', '[REDACTED]'],
    ['signature=i', '[REDACTED]'],
    ['{"api_key":"abc", "password":"two words"}', '{[REDACTED], [REDACTED]}'],
    ["secret='two words'", '[REDACTED]'],
    ['error Authorization: Bearer abc', 'error [REDACTED]'],
    ['Proxy-Authorization: Basic YWJj', '[REDACTED]'],
    ['Authorization: custom-credential', '[REDACTED]'],
    ['x-api-key: abc', '[REDACTED]'],
    ['x-goog-api-key: abc', '[REDACTED]'],
    ['Bearer abc', '[REDACTED]'],
    ['Basic YWJj', '[REDACTED]'],
    ['Token abc', '[REDACTED]'],
    ['Bearer "abc def"', '[REDACTED]'],
    ['Authorization: Digest username="kuba", realm="private", response="abc"', '[REDACTED]'],
    ['open "/home/kuba/a\\"b.md" failed', 'open "[PATH]" failed'],
    ['sk-1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', '[REDACTED]'],
    ['sk-ant-api03-1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', '[REDACTED]'],
    ['sk-abc-_', '[REDACTED]'],
    ['sk-proj-1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', '[REDACTED]'],
    ['sk-or-v1-1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', '[REDACTED]'],
    ['xai-1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', '[REDACTED]'],
    ['gsk_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', '[REDACTED]'],
    ['AIza1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', '[REDACTED]'],
    ['ghp_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', '[REDACTED]'],
    ['github_pat_1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ', '[REDACTED]'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJrdWJhIn0.signature', '[REDACTED]'],
    ['HTTP 404 POST /v1/messages returned invalid model anthropic/claude-sonnet-5-5', 'HTTP 404 POST /v1/messages returned invalid model anthropic/claude-sonnet-5-5'],
    ['ENOENT:/storage/emulated/0/Documents/Vault/private.md', 'ENOENT:[PATH]'],
    ['ENOENT:/storage/emulated/0/Documents/Moj Vault/prywatna notatka.md', 'ENOENT:[PATH]'],
    ['open "/storage/emulated/0/Documents/Moj Vault/prywatna notatka.md" failed', 'open "[PATH]" failed'],
    ["open '/home/kuba/Moj Vault/notatka.md' failed", "open '[PATH]' failed"],
    ['open "/home/kuba/O\'Brien/note.md" failed', 'open "[PATH]" failed'],
    ['ENOENT:/home/kuba/x; private note, more | data', 'ENOENT:[PATH]'],
    ['/Users/kuba/private note.md', '[PATH]'],
    ['/sdcard/private note.md', '[PATH]'],
    ['/data/user/0/private note.md', '[PATH]'],
    ['/mnt/private note.md', '[PATH]'],
    ['/var/private note.md', '[PATH]'],
    ['/private/private note.md', '[PATH]'],
    ['/tmp/private note.md', '[PATH]'],
    ['/root/private note.md', '[PATH]'],
    ['/opt/private note.md', '[PATH]'],
    ['/etc/private note.md', '[PATH]'],
    ['/usr/private note.md', '[PATH]'],
    ['/Volumes/private note.md', '[PATH]'],
    ['/media/private note.md', '[PATH]'],
    ['/run/private note.md', '[PATH]'],
    ['~/Moj Vault/private note.md', '[PATH]'],
    ['file:///home/kuba/Moj Vault/private note.md', '[PATH]'],
    ['file://server/Moj Vault/private note.md', '[PATH]'],
    ['\\\\serwer\\Moj Vault\\private note.md', '[PATH]'],
    ['C:\\Users\\kuba\\Moj Vault\\private note.md', '[PATH]'],
    ['open C:/Users/kuba/Moj Vault/private note.md', 'open [PATH]'],
    ['error="Z:/Moj Vault/private.md" done', 'error="[PATH]" done'],
    ['abcT:/relative', 'abcT:/relative'],
    ['9T:/relative', '9T:/relative'],
    ['/v1/messages', '/v1/messages'],
    ['/v1/chat/completions', '/v1/chat/completions'],
    ['/api/chat', '/api/chat'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36', 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36'],
    ['anthropic/claude-sonnet-5-5', 'anthropic/claude-sonnet-5-5'],
    ['lm_studio/gpt-6-astra-medium', 'lm_studio/gpt-6-astra-medium'],
    ['ea775b9 2026-11-13T07:40:59.306Z', 'ea775b9 2026-11-13T07:40:59.306Z'],
    ['.pkm-assistant/diagnostics/x-android.md', '.pkm-assistant/diagnostics/x-android.md'],
    ['412x880', '412x880'],
    ['HTTP: 200; chunks: 2; first chunk (ms): 1653', 'HTTP: 200; chunks: 2; first chunk (ms): 1653'],
    ['connect https://user:pass@host.test/?key=abc', 'connect [URL]'],
    ['first /tmp/private\nHTTP 404 /v1/messages', 'first [PATH]\nHTTP 404 /v1/messages'],
];
for (const [input, expected] of cases) {
    test(`diagnostic redaction: ${input}`, t => {
        const redact = diagnosticRedactor({});
        t.is(redact(input), expected);
        t.is(redact(redact(input)), expected, 'safe on the final Markdown pass too');
    });
}

test('known secrets include short, encoded, escaped and non-enumerable settings values', t => {
    const keys = { local: 'xyz', custom: 'odd secret+/value', quoted: 'a"b' };
    Object.defineProperty(keys, 'hydrated', { value: 'hydrated-value', enumerable: false });
    const redact = diagnosticRedactor({ apiKeys: keys });
    t.is(redact('xyz odd secret+/value odd%20secret%2B%2Fvalue a\\"b hydrated-value'),
        '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]');
});

test('short settings secrets do not rewrite replacement markers on repeated passes', t => {
    const redact = diagnosticRedactor({ apiKey: 'A' });
    t.is(redact('A /tmp/private'), '[REDACTED] [PATH]');
    t.is(redact('[REDACTED] [PATH]'), '[REDACTED] [PATH]');
});
