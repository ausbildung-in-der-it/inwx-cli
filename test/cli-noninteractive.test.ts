/**
 * Startet die gebaute CLI als Kindprozess ohne Terminal (stdin = /dev/null).
 *
 * Sicherheit: HOME zeigt auf ein leeres Temp-Verzeichnis und alle INWX_*-Variablen
 * sind entfernt. Es gibt also keine Zugangsdaten, ein Login und damit jeder
 * API-Aufruf (erst recht ein Kauf) ist ausgeschlossen. Die Tests prüfen, dass die
 * Bestätigungsprüfung VOR dem Login greift bzw. passiert wird.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'inwx.js');
const HOME = mkdtempSync(join(tmpdir(), 'inwx-cli-test-'));
after(() => rmSync(HOME, { recursive: true, force: true }));

function inwx(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME, NO_COLOR: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('INWX_')) delete env[key];
  const r = spawnSync(process.execPath, [BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, stdout: r.stdout, out: r.stdout + r.stderr };
}

const DOMAIN = 'example-test-xyz.com';
const BUY = ['domain', 'buy', DOMAIN, '--registrant', '1'];

test('CLI ohne TTY: passendes --confirm passiert die Bestätigung (scheitert erst am fehlenden Login)', () => {
  const r = inwx(...BUY, '--yes-live', '--yes', '--confirm', DOMAIN.toUpperCase());
  assert.equal(r.code, 1);
  assert.match(r.out, /Nicht angemeldet/);
  assert.doesNotMatch(r.out, /Bestätigung|stimmt nicht/);
});

test('CLI ohne TTY: abweichendes --confirm bricht mit Fehler ab', () => {
  const r = inwx(...BUY, '--yes-live', '--yes', '--confirm', 'example-test-xyz.de');
  assert.equal(r.code, 1);
  assert.match(r.out, /--confirm "example-test-xyz\.de" stimmt nicht mit example-test-xyz\.com überein/);
  assert.doesNotMatch(r.out, /Anmeldung|Nicht angemeldet/);
});

test('CLI ohne TTY: LIVE-Kauf ohne --confirm bricht mit Hinweis ab', () => {
  const r = inwx(...BUY, '--yes-live', '--yes');
  assert.equal(r.code, 1);
  assert.match(r.out, /LIVE-Kauf braucht eine Bestätigung: --confirm example-test-xyz\.com/);
  assert.doesNotMatch(r.out, /Anmeldung|Nicht angemeldet/);
});

test('CLI ohne TTY: buy ohne --yes bricht mit Hinweis ab', () => {
  const r = inwx(...BUY);
  assert.equal(r.code, 1);
  assert.match(r.out, /--yes angeben/);
});

test('CLI: buy --json schreibt genau ein JSON-Objekt auf stdout', () => {
  const r = inwx(...BUY, '--yes-live', '--yes', '--confirm', 'falsch.com', '--json');
  assert.equal(r.code, 1);
  const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.equal(parsed.ok, false);
  assert.equal(parsed.status, 'error');
  assert.equal(parsed.domain, DOMAIN);
  assert.equal(parsed.env, 'prod');
  assert.match(String(parsed.error), /stimmt nicht/);
});

test('CLI ohne TTY: andere Rückfragen nennen ihr Flag', () => {
  const cases: [string[], RegExp][] = [
    [['dns', 'rm', 'example.com', '123'], /--yes angeben/],
    [['domain', 'ns', 'example.com'], /--yes angeben/],
    [['contact', 'add', '--name', 'Max'], /--street, --pc, --city, --email, --voice/],
    [['login', '--ote'], /--user <name> und --password-stdin/],
    [['login', '--ote', '--user', 'max'], /--password-stdin .* oder INWX_PASSWORD/],
  ];
  for (const [args, pattern] of cases) {
    const r = inwx(...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.out, pattern, args.join(' '));
  }
});
