import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfirmMismatchError,
  NonInteractiveError,
  confirmMatches,
  isInteractive,
  planBuyConfirmation,
  requireTty,
} from '../src/interactive.js';

const base = { fqdn: 'example.com', live: true, dryRun: false, yes: true, tty: false };

test('confirmMatches: getrimmt und ohne Groß-/Kleinschreibung', () => {
  assert.equal(confirmMatches('example.com', 'example.com'), true);
  assert.equal(confirmMatches('  Example.COM \n', 'example.com'), true);
  assert.equal(confirmMatches('example.de', 'example.com'), false);
  assert.equal(confirmMatches('', 'example.com'), false);
});

test('isInteractive: folgt stdin.isTTY', () => {
  assert.equal(isInteractive({ isTTY: true }), true);
  assert.equal(isInteractive({ isTTY: false }), false);
  assert.equal(isInteractive({}), false);
});

test('requireTty: wirft ohne Terminal mit Hinweis auf das Flag', () => {
  assert.doesNotThrow(() => requireTty('--yes angeben', true));
  assert.throws(() => requireTty('--yes angeben', false), (e: Error) => e instanceof NonInteractiveError && /--yes/.test(e.message));
});

test('buy: passendes --confirm ersetzt die Tippbestätigung ohne Terminal', () => {
  assert.deepEqual(planBuyConfirmation({ ...base, confirm: 'example.com' }), { askYes: false, askTyped: false });
  assert.deepEqual(planBuyConfirmation({ ...base, confirm: ' EXAMPLE.com ' }), { askYes: false, askTyped: false });
});

test('buy: abweichendes --confirm bricht ab, auch mit Terminal und bei --dry-run', () => {
  for (const variant of [{}, { tty: true }, { dryRun: true }, { live: false }]) {
    assert.throws(
      () => planBuyConfirmation({ ...base, ...variant, confirm: 'example.de' }),
      (e: Error) => e instanceof ConfirmMismatchError && /stimmt nicht mit example\.com überein/.test(e.message),
    );
  }
});

test('buy: LIVE ohne Terminal und ohne --confirm bricht mit Hinweis ab', () => {
  assert.throws(
    () => planBuyConfirmation(base),
    (e: Error) => e instanceof NonInteractiveError && e.message.includes('--confirm example.com') && !e.message.includes('--yes und'),
  );
  // Fehlt auch --yes, nennt die Meldung beide Flags.
  assert.throws(
    () => planBuyConfirmation({ ...base, yes: false }),
    (e: Error) => e instanceof NonInteractiveError && e.message.includes('--yes und --confirm example.com'),
  );
});

test('buy: OT&E ohne Terminal braucht --yes', () => {
  assert.throws(
    () => planBuyConfirmation({ ...base, live: false, yes: false }),
    (e: Error) => e instanceof NonInteractiveError && /--yes/.test(e.message) && !/--confirm/.test(e.message),
  );
  assert.deepEqual(planBuyConfirmation({ ...base, live: false }), { askYes: false, askTyped: false });
});

test('buy: --dry-run braucht keine Bestätigung', () => {
  assert.deepEqual(planBuyConfirmation({ ...base, yes: false, dryRun: true }), { askYes: false, askTyped: false });
});

test('buy: mit Terminal werden fehlende Bestätigungen abgefragt', () => {
  assert.deepEqual(planBuyConfirmation({ ...base, yes: false, tty: true }), { askYes: true, askTyped: true });
  assert.deepEqual(planBuyConfirmation({ ...base, tty: true }), { askYes: false, askTyped: true });
  assert.deepEqual(planBuyConfirmation({ ...base, tty: true, confirm: 'example.com' }), { askYes: false, askTyped: false });
});
