/**
 * Entscheidungen rund um Rückfragen: Jede interaktive Rückfrage hat ein
 * Flag-Äquivalent. Fehlt das Flag und gibt es kein Terminal (Skript, CI, Agent),
 * bricht die CLI mit einem Hinweis auf das passende Flag ab, statt still zu enden.
 *
 * Bewusst ohne Seiteneffekte, damit die Logik ohne Terminal und Netzwerk testbar ist.
 */

/** Fehler, wenn eine Rückfrage nötig wäre, aber weder Flag noch Terminal vorhanden sind. */
export class NonInteractiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonInteractiveError';
  }
}

/** Fehler, wenn --confirm nicht zum Domainnamen passt. */
export class ConfirmMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmMismatchError';
  }
}

/** true, wenn stdin ein Terminal ist und Prompts beantwortet werden können. */
export function isInteractive(stdin: { isTTY?: boolean } = process.stdin): boolean {
  return Boolean(stdin.isTTY);
}

/**
 * Bricht ab, wenn kein Terminal da ist. `hint` nennt das Flag, mit dem sich die
 * Rückfrage ersetzen lässt, z. B. "--yes angeben".
 */
export function requireTty(hint: string, tty: boolean = isInteractive()): void {
  if (!tty) throw new NonInteractiveError(`Kein interaktives Terminal für die Rückfrage: ${hint}.`);
}

/** Gleiche Prüfung wie bei der getippten Bestätigung: getrimmt, ohne Groß-/Kleinschreibung. */
export function confirmMatches(input: string, fqdn: string): boolean {
  return input.trim().toLowerCase() === fqdn.trim().toLowerCase();
}

export interface BuyConfirmInput {
  fqdn: string;
  live: boolean;
  dryRun: boolean;
  yes: boolean;
  /** Wert von --confirm, undefined wenn nicht gesetzt. */
  confirm?: string;
  tty: boolean;
}

export interface BuyConfirmPlan {
  /** Ja/Nein-Rückfrage mit Preisanzeige stellen. */
  askYes: boolean;
  /** Domainnamen für den LIVE-Kauf eintippen lassen. */
  askTyped: boolean;
}

/**
 * Legt vor dem Login fest, welche Bestätigungen für `domain buy` nötig sind,
 * und wirft, wenn sie ohne Terminal nicht eingeholt werden können.
 *
 * - Ein gesetztes --confirm muss immer zum Domainnamen passen, auch bei --dry-run.
 * - --dry-run validiert nur und braucht keine Bestätigung.
 * - --yes ersetzt die Ja/Nein-Rückfrage, --confirm <domain> die getippte LIVE-Bestätigung.
 */
export function planBuyConfirmation(input: BuyConfirmInput): BuyConfirmPlan {
  const { fqdn, live, dryRun, yes, confirm, tty } = input;

  if (confirm !== undefined && !confirmMatches(confirm, fqdn)) {
    throw new ConfirmMismatchError(
      `--confirm "${confirm}" stimmt nicht mit ${fqdn} überein. Nichts gekauft.`,
    );
  }
  if (dryRun) return { askYes: false, askTyped: false };

  const plan: BuyConfirmPlan = { askYes: !yes, askTyped: live && confirm === undefined };
  if (tty) return plan;

  if (plan.askTyped) {
    const missing = [...(plan.askYes ? ['--yes'] : []), `--confirm ${fqdn}`].join(' und ');
    throw new NonInteractiveError(
      `LIVE-Kauf braucht eine Bestätigung: ${missing} angeben oder ein interaktives Terminal nutzen. Nichts gekauft.`,
    );
  }
  if (plan.askYes) {
    throw new NonInteractiveError(
      'Kein interaktives Terminal für die Rückfrage: --yes angeben, um den Kauf zu bestätigen. Nichts gekauft.',
    );
  }
  return plan;
}
