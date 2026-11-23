import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  intro,
  outro,
  text,
  password as passwordPrompt,
  select,
  confirm,
  spinner,
  isCancel,
  cancel,
  note,
  log,
} from '@clack/prompts';
import pc from 'picocolors';

import { Domrobot, ApiError, TfaRequiredError, toFqdn } from './api.js';
import { saveProfile, getProfile, removeProfile, CONFIG_FILE } from './config.js';
import {
  logo,
  brand,
  dim,
  ok,
  warn,
  err,
  accent,
  recordTable,
  planLine,
  checkTable,
  availStyle,
  contactTable,
  domainTable,
  apiDateStr,
} from './ui.js';
import {
  assertValidDomain,
  splitDomain,
  tldHints,
  parsePeriod,
  normalizeCountryCode,
  normalizePhone,
  secureOnlyAckKey,
} from './validate.js';
import { isInteractive, requireTty, confirmMatches, planBuyConfirmation, type BuyConfirmPlan } from './interactive.js';
import type {
  ContactType,
  DnsRecord,
  DomainCheckResult,
  Env,
  ResolvedProfile,
} from './types.js';

const program = new Command();
const DEFAULT_INWX_NAMESERVERS = ['ns.inwx.de', 'ns2.inwx.de'];

function envFromOpts(): Env {
  return program.opts().ote ? 'ote' : 'prod';
}

function envBadge(env: Env): string {
  return env === 'ote' ? pc.bgYellow(pc.black(' OTE-TEST ')) : pc.bgCyan(pc.black(' PROD '));
}

/**
 * JSON-Modus (z. B. `domain buy --json`): Fortschritt und Prompts gehen auf stderr,
 * stdout bekommt genau ein JSON-Objekt mit dem Ergebnis.
 */
let jsonOut: ((data: Record<string, unknown>) => void) | undefined;

function startJsonOutput(base: Record<string, unknown>): void {
  const writeStdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  let emitted = false;
  jsonOut = (data) => {
    if (emitted) return;
    emitted = true;
    writeStdout(JSON.stringify({ ...base, ...data }) + '\n');
  };
}

function die(message: string, extra: Record<string, unknown> = {}): never {
  jsonOut?.({ ok: false, status: 'error', error: message, ...extra });
  log.error(err(message));
  process.exit(1);
}

/** Abbruch durch den Nutzer: Meldung, Exit-Code 1, aber regulär zurückkehren (Logout läuft noch). */
function cancelled(message = 'Abgebrochen.'): void {
  jsonOut?.({ ok: false, status: 'cancelled', error: message });
  cancel(message);
  process.exitCode = 1;
}

function cancelExit(message = 'Abgebrochen.'): never {
  cancelled(message);
  process.exit(1);
}

/** Bricht ohne Terminal ab, bevor eine Rückfrage gestellt würde. `hint` nennt das Ersatz-Flag. */
function ensureTty(hint: string): void {
  try {
    requireTty(hint);
  } catch (e) {
    die((e as Error).message);
  }
}

/** Globales --totp-code, falls gesetzt (für 2FA ohne Terminal und ohne gespeichertes Secret). */
function totpCodeFromOpts(): string | undefined {
  const code = program.opts().totpCode as string | undefined;
  if (code === undefined) return undefined;
  if (!/^\d{6}$/.test(code.trim())) die('--totp-code muss aus 6 Ziffern bestehen.');
  return code.trim();
}

class NotLoggedIn extends Error {}

/** Meldet sich an und gibt einen verbundenen Client zurück (mit 2FA-Fallback). */
async function connect(env: Env, { interactive = true } = {}): Promise<Domrobot> {
  const prof = await getProfile(env);
  if (!prof || !prof.user || !prof.pass) throw new NotLoggedIn(env);
  const user = prof.user;
  const pass = prof.pass;

  const attempt = async (extra?: { totpCode?: string }): Promise<Domrobot> => {
    const client = new Domrobot(env);
    await client.login(user, pass, { totpSecret: prof.totpSecret, ...extra });
    return client;
  };

  const totpCode = totpCodeFromOpts();
  const s = spinner();
  s.start(`Anmeldung bei INWX (${env})…`);
  try {
    const client = await attempt(totpCode ? { totpCode } : undefined);
    s.stop(`${ok('✓')} Angemeldet als ${accent(user)} ${dim('(' + env + ')')}`);
    return client;
  } catch (e) {
    if (e instanceof TfaRequiredError && !(interactive && isInteractive() && !jsonOut)) {
      s.stop(err('✗ 2FA-Code erforderlich'));
      throw new Error(
        '2FA ist aktiv, aber kein Code vorhanden und kein interaktives Terminal: ' +
          '--totp-code <code> angeben oder das TOTP-Secret hinterlegen (inwx login bzw. INWX_TOTP_SECRET).',
      );
    }
    if (e instanceof TfaRequiredError) {
      s.stop(warn('2FA erforderlich'));
      const code = await text({
        message: 'Aktueller 6-stelliger 2FA-Code',
        validate: (v) => (/^\d{6}$/.test(v.trim()) ? undefined : 'Bitte 6 Ziffern.'),
      });
      if (isCancel(code)) cancelExit();
      const s2 = spinner();
      s2.start('Anmeldung bei INWX…');
      const client = await attempt({ totpCode: code.trim() });
      s2.stop(`${ok('✓')} Angemeldet als ${accent(user)}`);
      return client;
    }
    s.stop(err('✗ Anmeldung fehlgeschlagen'));
    throw e;
  }
}

async function withClient<T>(env: Env, fn: (client: Domrobot) => Promise<T>): Promise<T | undefined> {
  let client: Domrobot;
  try {
    client = await connect(env);
  } catch (e) {
    if (e instanceof NotLoggedIn) {
      die(`Nicht angemeldet für "${env}". Führe zuerst ${accent('inwx login' + (env === 'ote' ? ' --ote' : ''))} aus.`);
    }
    die(e instanceof Error ? e.message : String(e));
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      /* egal */
    }
  }
}

/* ────────────────────────── accounting ────────────────────────── */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(flag: string, v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  // Format und echtes Kalenderdatum (kein 2026-02-30): Rundlauf über Date muss denselben Tag ergeben.
  const d = new Date(`${v}T00:00:00Z`);
  if (!DATE_RE.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    die(`${flag} erwartet ein gültiges Datum im Format JJJJ-MM-TT, nicht "${v}".`);
  }
  return v;
}

/** Prüft --from/--to (Format, Kalender, Reihenfolge). */
function checkRange(fromRaw: string | undefined, toRaw: string | undefined): { from?: string; to?: string } {
  const from = checkDate('--from', fromRaw);
  const to = checkDate('--to', toRaw);
  if (from && to && to < from) die(`--to (${to}) liegt vor --from (${from}).`);
  return { from, to };
}

function euro(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function inRange(date: string, from?: string, to?: string): boolean {
  const d = date.slice(0, 10);
  return (!from || d >= from) && (!to || d <= to);
}

interface AccountingRangeOpts {
  from?: string;
  to?: string;
  json?: boolean;
}

async function cmdAccountingInvoices(opts: AccountingRangeOpts): Promise<void> {
  const env = envFromOpts();
  if (opts.json) startJsonOutput({ command: 'accounting invoices', env });
  const { from, to } = checkRange(opts.from, opts.to);
  await withClient(env, async (client) => {
    const all = await client.listInvoices();
    const rows = all.filter((i) => inRange(i.date, from, to)).sort((a, b) => a.date.localeCompare(b.date));
    if (opts.json) {
      jsonOut?.({ ok: true, from, to, invoices: rows });
      return;
    }
    console.log('');
    console.log(`  ${brand('accounting invoices')} ${envBadge(env)}  ${dim(rows.length + ' von ' + all.length + ' Belegen')}`);
    console.log('');
    for (const i of rows) {
      console.log(`  ${i.date}  ${accent(i.invoiceId.padEnd(12))} ${i.type.padEnd(12)} ${euro(i.afterTax).padStart(12)}  ${dim('netto ' + euro(i.preTax))}`);
    }
    const sum = rows.reduce((a, i) => a + i.afterTax, 0);
    console.log('');
    console.log(`  ${dim('Summe brutto')} ${euro(sum)}`);
    console.log('');
  });
}

interface AccountingInvoiceOpts extends AccountingRangeOpts {
  out: string;
  xml?: boolean;
}

async function cmdAccountingInvoice(ids: string[], opts: AccountingInvoiceOpts): Promise<void> {
  const env = envFromOpts();
  if (opts.json) startJsonOutput({ command: 'accounting invoice', env });
  const { from, to } = checkRange(opts.from, opts.to);
  if (ids.length && (from || to)) die('Entweder Rechnungsnummern oder einen Zeitraum mit --from/--to angeben, nicht beides.');
  if (!ids.length && !from && !to) die('Rechnungsnummern angeben oder einen Zeitraum mit --from/--to.');
  const outDir = resolve(opts.out);
  await mkdir(outDir, { recursive: true });
  await withClient(env, async (client) => {
    const list = await client.listInvoices();
    const byId = new Map(list.map((i) => [i.invoiceId, i]));
    const wanted = ids.length ? ids : list.filter((i) => inRange(i.date, from, to)).map((i) => i.invoiceId);
    const files: Array<Record<string, unknown>> = [];
    for (const id of wanted) {
      const meta = byId.get(id);
      const { pdf, xml } = await client.getInvoice(id);
      const base = `${meta?.date ?? 'unbekannt'}_INWX_${id}`;
      const pdfPath = resolve(outDir, base + '.pdf');
      await writeFile(pdfPath, pdf);
      let xmlPath: string | undefined;
      if (opts.xml && xml) {
        xmlPath = resolve(outDir, base + '.xml');
        await writeFile(xmlPath, xml);
      }
      files.push({ invoiceId: id, date: meta?.date, afterTax: meta?.afterTax, type: meta?.type, pdf: pdfPath, xml: xmlPath });
      if (!opts.json) console.log(`  ${ok('✓')} ${id} ${dim('→')} ${pdfPath}${xmlPath ? dim(' + .xml') : ''}`);
    }
    if (opts.json) jsonOut?.({ ok: true, files });
    else console.log(`\n  ${files.length} Beleg(e) gespeichert in ${outDir}\n`);
  });
}

interface AccountingStatementOpts extends AccountingRangeOpts {
  csv?: string;
}

async function cmdAccountingStatement(opts: AccountingStatementOpts): Promise<void> {
  const env = envFromOpts();
  if (opts.json) startJsonOutput({ command: 'accounting statement', env });
  if (!opts.from) die('--from ist Pflicht (JJJJ-MM-TT).');
  const range = checkRange(opts.from, opts.to ?? new Date().toISOString().slice(0, 10));
  const from = range.from!;
  const to = range.to!;
  await withClient(env, async (client) => {
    const rows = (await client.accountingLog(from, to))
      .map((r) => ({ ...r, date: apiDateStr(r.date) }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    const payments = rows.filter((r) => r.amount > 0).reduce((a, r) => a + r.amount, 0);
    const charges = rows.filter((r) => r.amount < 0).reduce((a, r) => a + r.amount, 0);
    if (opts.csv) {
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = ['Datum;Typ;Details;Betrag;ID'].concat(
        rows.map((r) => [r.date, r.type, r.details, r.amount.toFixed(2).replace('.', ','), r.id].map(esc).join(';')),
      );
      await writeFile(resolve(opts.csv), lines.join('\n') + '\n');
    }
    if (opts.json) {
      jsonOut?.({ ok: true, from, to, payments, charges, net: payments + charges, entries: rows, csv: opts.csv ? resolve(opts.csv) : undefined });
      return;
    }
    console.log('');
    console.log(`  ${brand('accounting statement')} ${envBadge(env)}  ${dim(from + ' bis ' + to)}`);
    console.log('');
    for (const r of rows) {
      const amt = euro(r.amount).padStart(12);
      console.log(`  ${r.date}  ${r.type.padEnd(10)} ${String(r.details ?? '').padEnd(22)} ${r.amount < 0 ? warn(amt) : ok(amt)}`);
    }
    console.log('');
    console.log(`  ${dim('Aufladungen')}  ${euro(payments)}`);
    console.log(`  ${dim('Belastungen')}  ${euro(charges)}`);
    console.log(`  ${dim('Saldo im Zeitraum')} ${euro(payments + charges)}`);
    if (opts.csv) console.log(`  ${dim('CSV')} ${resolve(opts.csv)}`);
    console.log('');
  });
}

/* ────────────────────────── login ────────────────────────── */
interface LoginOpts {
  user?: string;
  passwordStdin?: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Login ohne Prompts: --user plus Passwort aus --password-stdin oder INWX_PASSWORD.
 * 2FA über INWX_TOTP_SECRET (wird gespeichert) oder das globale --totp-code (nur einmalig).
 */
async function loginFromFlags(opts: LoginOpts): Promise<{ user: string; pass: string; totpSecret?: string; totpCode?: string }> {
  const user = opts.user!.trim();
  if (!user) die('--user darf nicht leer sein.');
  let pass: string | undefined;
  if (opts.passwordStdin) {
    if (isInteractive()) die('--password-stdin erwartet das Passwort über eine Pipe, z. B. `printf %s "$PW" | inwx login --user <name> --password-stdin`.');
    pass = (await readStdin()).replace(/\r?\n$/, '');
  } else {
    pass = process.env.INWX_PASSWORD;
  }
  if (!pass) {
    if (!isInteractive()) die('Kein Passwort: --password-stdin (Passwort über stdin) oder INWX_PASSWORD setzen.');
    const p = await passwordPrompt({
      message: 'INWX Passwort',
      validate: (v) => (v ? undefined : 'Bitte ein Passwort eingeben.'),
    });
    if (isCancel(p)) cancelExit();
    pass = p;
  }
  const totpSecret = process.env.INWX_TOTP_SECRET?.trim() || undefined;
  return { user, pass, totpSecret, totpCode: totpCodeFromOpts() };
}

async function cmdLogin(opts: LoginOpts = {}): Promise<void> {
  const env = envFromOpts();
  intro(`${logo()}  ${envBadge(env)}`);

  let user: string;
  let pass: string;
  let totpSecret: string | undefined;
  let totpCode: string | undefined;

  if (opts.user !== undefined) {
    ({ user, pass, totpSecret, totpCode } = await loginFromFlags(opts));
  } else {
    ensureTty('--user <name> und --password-stdin (oder INWX_PASSWORD) angeben');

    const u = await text({
      message: 'INWX Benutzername',
      validate: (v) => (v.trim() ? undefined : 'Bitte einen Benutzernamen eingeben.'),
    });
    if (isCancel(u)) return void cancelled();
    user = u.trim();

    const p = await passwordPrompt({
      message: 'INWX Passwort',
      validate: (v) => (v ? undefined : 'Bitte ein Passwort eingeben.'),
    });
    if (isCancel(p)) return void cancelled();
    pass = p;

    const has2fa = await confirm({
      message: 'Ist auf dem Account 2FA (Mobile-TAN / TOTP) aktiv?',
      initialValue: true,
    });
    if (isCancel(has2fa)) return void cancelled();

    if (has2fa) {
      const mode = await confirm({
        message: 'TOTP-Secret dauerhaft speichern (Codes automatisch erzeugen)?',
        initialValue: true,
      });
      if (isCancel(mode)) return void cancelled();
      if (mode) {
        const sec = await passwordPrompt({
          message: 'TOTP-Secret (Base32, aus der 2FA-Einrichtung)',
          validate: (v) => (v.trim().length >= 16 ? undefined : 'Sieht zu kurz aus.'),
        });
        if (isCancel(sec)) return void cancelled();
        totpSecret = sec.trim();
      } else {
        const code = await text({
          message: 'Aktueller 6-stelliger 2FA-Code',
          validate: (v) => (/^\d{6}$/.test(v.trim()) ? undefined : 'Bitte 6 Ziffern.'),
        });
        if (isCancel(code)) return void cancelled();
        totpCode = code.trim();
      }
    }
  }

  const s = spinner();
  s.start('Zugangsdaten prüfen…');
  try {
    const client = new Domrobot(env);
    await client.login(user, pass, { totpSecret, totpCode });
    await client.logout();
    s.stop(`${ok('✓')} Anmeldung erfolgreich.`);
  } catch (e) {
    s.stop(err('✗ Anmeldung fehlgeschlagen.'));
    if (e instanceof TfaRequiredError) {
      die('2FA ist aktiv: --totp-code <code> angeben oder INWX_TOTP_SECRET setzen (wird dann gespeichert).');
    }
    die(e instanceof Error ? e.message : String(e));
  }

  await saveProfile(env, { user, pass, totpSecret });
  note(
    `${dim('Profil:')} ${env}\n${dim('Gespeichert in:')} ${CONFIG_FILE} ${dim('(chmod 600)')}` +
      (totpSecret ? '' : `\n${warn('Ohne gespeichertes TOTP-Secret fragt jede Aktion nach dem aktuellen Code.')}`),
    'Gespeichert',
  );
  outro(`${ok('Fertig.')} Nächster Schritt: ${accent('inwx dns ls <domain>')}`);
}

/* ────────────────────────── logout ────────────────────────── */
async function cmdLogout(): Promise<void> {
  const env = envFromOpts();
  const removed = await removeProfile(env);
  if (removed) log.success(`Abgemeldet, Profil "${env}" entfernt.`);
  else log.info(`Kein gespeichertes Profil für "${env}".`);
}

/* ────────────────────────── whoami ────────────────────────── */
async function cmdWhoami(): Promise<void> {
  const env = envFromOpts();
  const prof: ResolvedProfile | null = await getProfile(env);
  if (!prof || !prof.user) {
    die(`Nicht angemeldet für "${env}". Führe ${accent('inwx login')} aus.`);
  }
  const src = prof.fromEnv ? dim(' (aus Umgebungsvariablen)') : '';
  log.message(`${envBadge(env)}  ${accent(prof.user)}${src}`);
  if (prof.savedAt) log.message(dim(`gespeichert: ${prof.savedAt}`));
}

/* ────────────────────────── dns ls ────────────────────────── */
async function cmdDnsLs(domain: string): Promise<void> {
  const env = envFromOpts();
  await withClient(env, async (client) => {
    const records: DnsRecord[] = await client.listRecords(domain);
    console.log('');
    console.log(`  ${brand('DNS')} ${dim('·')} ${accent(domain)} ${envBadge(env)}  ${dim(records.length + ' Records')}`);
    console.log('');
    console.log(recordTable(records));
    console.log('');
  });
}

/* ────────────────────────── dns zone add ────────────────────────── */
interface DnsZoneAddOpts {
  soaEmail?: string;
  dryRun?: boolean;
}
async function cmdDnsZoneAdd(domain: string, opts: DnsZoneAddOpts): Promise<void> {
  const env = envFromOpts();
  const fqdn = domain.trim().toLowerCase();
  try {
    assertValidDomain(fqdn);
  } catch (e) {
    return die((e as Error).message);
  }
  await withClient(env, async (client) => {
    const res = await client.createNameserverZone({
      domain: fqdn,
      type: 'MASTER',
      ns: DEFAULT_INWX_NAMESERVERS,
      ignoreExisting: true,
      soaEmail: opts.soaEmail,
      testing: Boolean(opts.dryRun),
    });
    log.success(
      opts.dryRun
        ? `${ok('✓')} DNS-Zone validiert (nicht angelegt).`
        : `${ok('+')} MASTER-Zone ${accent(fqdn)} angelegt${res.roId ? ` (roId ${res.roId})` : ''}.`,
    );
  });
}

/* ────────────────────────── dns add ────────────────────────── */
interface DnsAddOpts {
  ttl?: string;
  prio?: string;
}
async function cmdDnsAdd(domain: string, name: string, type: string, content: string, opts: DnsAddOpts): Promise<void> {
  const env = envFromOpts();
  const t = String(type).toUpperCase();
  await withClient(env, async (client) => {
    const fqdn = toFqdn(name, domain);
    await client.createRecord({
      domain,
      name: fqdn,
      type: t,
      content,
      ttl: opts.ttl ? Number(opts.ttl) : 3600,
      prio: opts.prio,
    });
    log.success(`${ok('+')} ${t} ${accent(fqdn)} → ${content}`);
  });
}

/* ────────────────────────── dns rm ────────────────────────── */
interface YesOpt {
  yes?: boolean;
}
async function cmdDnsRm(domain: string, id: string, opts: YesOpt): Promise<void> {
  const env = envFromOpts();
  if (!opts.yes) ensureTty('--yes angeben, um ohne Rückfrage zu löschen');
  await withClient(env, async (client) => {
    if (!opts.yes) {
      const yes = await confirm({ message: `Record #${id} in ${domain} wirklich löschen?`, initialValue: false });
      if (isCancel(yes) || !yes) return void cancelled('Abgebrochen.');
    }
    await client.deleteRecord(id);
    log.success(`${warn('−')} Record #${id} gelöscht.`);
  });
}

/* ────────────────────────── dns apply ────────────────────────── */
interface RecordSpec {
  name: string;
  type: string;
  content: string;
  ttl?: number;
  prio?: number | string;
}
function normalizeRecordsFile(raw: string): { domain: string; records: RecordSpec[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Records-Datei ist kein gültiges JSON: ${(e as Error).message}`);
  }
  const d = doc as { domain?: string; records?: RecordSpec[] };
  const domain = d.domain;
  const records = Array.isArray(doc) ? (doc as RecordSpec[]) : d.records;
  if (!domain || !Array.isArray(records)) {
    throw new Error('Datei braucht { "domain": "...", "records": [ ... ] }.');
  }
  return { domain, records };
}

interface ApplyOpts {
  dryRun?: boolean;
  yes?: boolean;
}
async function cmdDnsApply(file: string, opts: ApplyOpts): Promise<void> {
  const env = envFromOpts();
  const path = resolve(process.cwd(), file);
  let spec: { domain: string; records: RecordSpec[] };
  try {
    spec = normalizeRecordsFile(await readFile(path, 'utf8'));
  } catch (e) {
    return die((e as Error).message);
  }

  intro(`${logo()} ${dim('apply')}  ${envBadge(env)} ${accent(spec.domain)}`);

  await withClient(env, async (client) => {
    const existing = await client.listRecords(spec.domain);
    interface PlanItem {
      action: 'create' | 'update' | 'skip';
      record: RecordSpec & { type: string };
      fqdn: string;
      id?: number;
      oldContent?: string;
    }
    const plan: PlanItem[] = [];
    for (const rec of spec.records) {
      const type = String(rec.type).toUpperCase();
      const fqdn = toFqdn(rec.name, spec.domain);
      const match = existing.find(
        (e) => e.name === fqdn && e.type === type && (type !== 'MX' || String(e.prio) === String(rec.prio ?? '')),
      );
      if (!match) {
        plan.push({ action: 'create', record: { ...rec, type }, fqdn });
      } else if (String(match.content) !== String(rec.content) || String(match.ttl) !== String(rec.ttl ?? match.ttl)) {
        plan.push({ action: 'update', record: { ...rec, type }, fqdn, id: match.id, oldContent: match.content });
      } else {
        plan.push({ action: 'skip', record: { ...rec, type }, fqdn });
      }
    }

    const counts = plan.reduce<Record<string, number>>((a, p) => ((a[p.action] = (a[p.action] || 0) + 1), a), {});
    console.log('');
    for (const p of plan) console.log(planLine(p));
    console.log('');
    console.log(
      `  ${ok(String(counts.create || 0) + ' anlegen')}  ${warn(String(counts.update || 0) + ' ändern')}  ${dim(String(counts.skip || 0) + ' unverändert')}`,
    );
    console.log('');

    const todo = plan.filter((p) => p.action !== 'skip');
    if (!todo.length) return void outro(ok('Alles aktuell, nichts zu tun.'));

    if (opts.dryRun) return void outro(dim('Dry-Run, keine Änderungen geschrieben.'));

    if (!opts.yes) {
      ensureTty('--yes zum Anwenden oder --dry-run für nur den Plan angeben');
      const go = await confirm({
        message: `${todo.length} Änderung(en) auf ${env === 'ote' ? 'dem OTE-Testsystem' : 'die LIVE-Domain'} schreiben?`,
        initialValue: env === 'ote',
      });
      if (isCancel(go) || !go) return void cancelled('Abgebrochen, nichts geändert.');
    }

    const s = spinner();
    let done = 0;
    for (const p of todo) {
      s.start(`${p.action === 'create' ? 'Anlegen' : 'Ändern'}: ${p.record.type} ${p.fqdn}`);
      try {
        if (p.action === 'create') {
          await client.createRecord({ domain: spec.domain, name: p.fqdn, type: p.record.type, content: p.record.content, ttl: p.record.ttl ?? 3600, prio: p.record.prio });
        } else {
          await client.updateRecord(p.id!, { content: p.record.content, ttl: p.record.ttl ?? 3600, prio: p.record.prio });
        }
        done++;
        s.stop(`${ok('✓')} ${p.record.type} ${p.fqdn}`);
      } catch (e) {
        s.stop(`${err('✗')} ${p.record.type} ${p.fqdn} — ${(e as Error).message}`);
      }
    }
    if (done < todo.length) {
      process.exitCode = 1;
      return void outro(err(`${todo.length - done} von ${todo.length} Änderung(en) fehlgeschlagen.`));
    }
    outro(`${ok('Fertig.')} ${done}/${todo.length} Record(s) geschrieben.`);
  });
}

/* ────────────────────────── domain check ────────────────────────── */
async function cmdDomainCheck(names: string[]): Promise<void> {
  const env = envFromOpts();
  const checked: string[] = [];
  const hints: string[] = [];
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    try {
      assertValidDomain(name);
      checked.push(name);
      for (const hint of tldHints(name)) if (!hints.includes(hint)) hints.push(hint);
    } catch (e) {
      log.error(err(`${raw}: ${(e as Error).message}`));
    }
  }
  if (!checked.length) return void die('Keine gültigen Domainnamen zum Prüfen.');

  await withClient(env, async (client) => {
    // Hinweise erst nach dem Login, damit der Spinner nicht dazwischenfunkt.
    for (const hint of hints) log.warn(warn(hint));
    const results: DomainCheckResult[] = await client.checkDomains(checked);
    console.log('');
    console.log(`  ${brand('domain check')} ${envBadge(env)}  ${dim(results.length + ' geprüft')}`);
    console.log('');
    console.log(checkTable(results));
    console.log('');
  });
}

/* ────────────────────────── domain price ────────────────────────── */
async function cmdDomainPrice(name: string): Promise<void> {
  const env = envFromOpts();
  const fqdn = name.trim().toLowerCase();
  try {
    assertValidDomain(fqdn);
  } catch (e) {
    return die((e as Error).message);
  }
  const { tld } = splitDomain(fqdn);

  await withClient(env, async (client) => {
    console.log('');
    console.log(`  ${brand('domain price')} ${dim('·')} ${accent(fqdn)} ${envBadge(env)}`);
    console.log('');

    // Konkreter Domainpreis + Verfügbarkeit aus domain.check.
    try {
      const [check] = await client.checkDomains([fqdn]);
      if (check) {
        const st = availStyle(check.avail);
        const priceStr = check.price !== undefined ? `${check.price.toFixed(2)} EUR` : dim('kein Preis in Antwort');
        console.log(`  Status:  ${st.color(st.label)}`);
        console.log(`  Preis:   ${priceStr}`);
      }
    } catch (e) {
      log.warn(warn(`domain.check nicht möglich: ${(e as Error).message}`));
    }

    // TLD-weite Preisliste (create/renew/transfer) aus domain.getPrices.
    try {
      const [p] = await client.getPrices([tld]);
      if (p) {
        const cur = p.currency ?? 'EUR';
        const fmt = (v?: number) => (v !== undefined ? `${v.toFixed(2)} ${cur}` : dim('–'));
        console.log('');
        console.log(`  ${dim('TLD .' + tld)}`);
        console.log(`  Registrierung: ${fmt(p.createPrice)} / Jahr`);
        console.log(`  Verlängerung:  ${fmt(p.renewalPrice)} / Jahr`);
        console.log(`  Transfer:      ${fmt(p.transferPrice)}`);
      }
    } catch (e) {
      log.warn(warn(`domain.getPrices nicht verfügbar: ${(e as Error).message}`));
    }
    console.log('');
  });
}

/* ────────────────────────── domain ls / info ────────────────────────── */
async function cmdDomainLs(): Promise<void> {
  const env = envFromOpts();
  await withClient(env, async (client) => {
    const domains = await client.listDomains();
    console.log('');
    console.log(`  ${brand('domains')} ${envBadge(env)}  ${dim(domains.length + ' Domains')}`);
    console.log('');
    console.log(domainTable(domains));
    console.log('');
  });
}

async function cmdDomainInfo(name: string): Promise<void> {
  const env = envFromOpts();
  const fqdn = name.trim().toLowerCase();
  await withClient(env, async (client) => {
    const info = await client.domainInfo(fqdn);
    console.log('');
    console.log(`  ${brand('domain')} ${dim('·')} ${accent(info.domain)} ${envBadge(env)}`);
    console.log('');
    const line = (k: string, v: unknown) => {
      if (v === undefined || v === null || v === '') return;
      console.log(`  ${dim(k.padEnd(14))} ${String(v)}`);
    };
    line('Status', info.status);
    line('Angelegt', apiDateStr(info.crDate));
    line('Läuft ab', apiDateStr(info.exDate));
    line('Registrant', info.registrant);
    line('Admin-C', info.admin);
    line('Tech-C', info.tech);
    line('Billing-C', info.billing);
    line('Nameserver', Array.isArray(info.ns) ? info.ns.join(', ') : info.ns);
    line('Transfer-Lock', info.transferLock ? 'ja' : undefined);
    console.log('');
  });
}

/* ────────────────────────── domain ns ────────────────────────── */
interface DomainNsOpts {
  ns?: string;
  dryRun?: boolean;
  yes?: boolean;
}
async function cmdDomainNs(name: string, opts: DomainNsOpts): Promise<void> {
  const env = envFromOpts();
  const fqdn = name.trim().toLowerCase();
  try {
    assertValidDomain(fqdn);
  } catch (e) {
    return die((e as Error).message);
  }
  const ns = (opts.ns ?? DEFAULT_INWX_NAMESERVERS.join(','))
    .split(',')
    .map((server) => server.trim().toLowerCase())
    .filter(Boolean);
  if (ns.length < 2) return die('Mindestens zwei Nameserver sind erforderlich.');
  if (!opts.dryRun && !opts.yes) ensureTty('--yes angeben, um die Nameserver ohne Rückfrage zu setzen');

  await withClient(env, async (client) => {
    if (!opts.dryRun && !opts.yes) {
      const accepted = await confirm({
        message: `Nameserver von ${fqdn} auf ${ns.join(', ')} setzen?`,
        initialValue: false,
      });
      if (isCancel(accepted) || !accepted) return void cancelled('Abgebrochen.');
    }
    await client.updateDomain({ domain: fqdn, ns, testing: Boolean(opts.dryRun) });
    log.success(
      opts.dryRun
        ? `${ok('✓')} Nameserver-Änderung validiert (nicht ausgeführt).`
        : `${ok('✓')} Nameserver-Änderung für ${accent(fqdn)} übermittelt.`,
    );
  });
}

/* ────────────────────────── domain buy ────────────────────────── */
interface BuyOpts {
  period?: string;
  registrant?: string;
  admin?: string;
  tech?: string;
  billing?: string;
  ns?: string;
  renewalMode?: string;
  ext?: string[];
  dryRun?: boolean;
  yesLive?: boolean;
  yes?: boolean;
  confirm?: string;
  json?: boolean;
}
/** Registry-Code für die JSON-Ausgabe, falls der Fehler von der API kommt. */
function apiErrorDetails(e: unknown): Record<string, unknown> {
  return e instanceof ApiError ? { apiCode: e.code, apiReason: e.reason } : {};
}
function registryDiagnostic(result: Record<string, unknown>): string | undefined {
  const diagnostic = JSON.stringify(result, null, 2);
  return /\b(?:warning|failed|error|refused)\b/i.test(diagnostic) ? diagnostic : undefined;
}
async function cmdDomainBuy(name: string, opts: BuyOpts): Promise<void> {
  const fqdn = name.trim().toLowerCase();

  // Sicherheit: Kauf läuft standardmäßig auf OT&E. Prod NUR mit --yes-live.
  const live = Boolean(opts.yesLive);
  const env: Env = live ? 'prod' : 'ote';
  const testing = Boolean(opts.dryRun);
  if (opts.json) startJsonOutput({ command: 'domain buy', domain: fqdn, env, dryRun: testing });

  // Syntax + TLD-Hinweise.
  try {
    assertValidDomain(fqdn);
  } catch (e) {
    return die((e as Error).message);
  }
  if (!opts.registrant) return die('--registrant <contactId> ist Pflicht. Kontakt-ID via `inwx contact ls` ermitteln.');
  const registrant = Number(opts.registrant);
  if (!Number.isInteger(registrant) || registrant <= 0) return die('--registrant muss eine numerische Kontakt-ID sein.');

  let period;
  try {
    period = parsePeriod(opts.period, '1Y');
  } catch (e) {
    return die((e as Error).message);
  }
  const ns = (opts.ns ?? DEFAULT_INWX_NAMESERVERS.join(',')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const usesDefaultInwxNameservers =
    ns.length === DEFAULT_INWX_NAMESERVERS.length && DEFAULT_INWX_NAMESERVERS.every((server) => ns.includes(server));

  // TLD-Zusatzdaten aus --ext plus Auto-Bestätigung für Secure-only-TLDs (.app/.dev/.page).
  const extData: Record<string, string | number> = {};
  for (const kv of opts.ext ?? []) {
    const eq = kv.indexOf('=');
    if (eq < 1) return die(`--ext erwartet key=value, bekam "${kv}".`);
    extData[kv.slice(0, eq).trim()] = kv.slice(eq + 1);
  }
  const ackKey = secureOnlyAckKey(splitDomain(fqdn).tld);
  if (ackKey && !(ackKey in extData)) extData[ackKey] = 1;

  // Bestätigungen vor dem Login klären: ohne Terminal braucht es --yes bzw. --confirm.
  // Im JSON-Modus gibt es grundsätzlich keine Rückfragen.
  let confirmPlan: BuyConfirmPlan;
  try {
    confirmPlan = planBuyConfirmation({
      fqdn,
      live,
      dryRun: testing,
      yes: Boolean(opts.yes),
      confirm: opts.confirm,
      tty: !opts.json && isInteractive(),
    });
  } catch (e) {
    return die((e as Error).message);
  }

  intro(`${logo()} ${dim('buy')}  ${envBadge(env)} ${accent(fqdn)}`);

  await withClient(env, async (client) => {
    // Hinweise erst nach der Anmeldung, damit der Login-Spinner nicht dazwischenfunkt.
    for (const hint of tldHints(fqdn)) log.warn(warn(hint));
    if (ackKey) log.info(dim(`Secure-only-TLD: ${ackKey}=1 wird gesetzt.`));
    if (live) {
      log.warn(err('ACHTUNG: --yes-live gesetzt. Dies ist eine ECHTE, KOSTENPFLICHTIGE Registrierung auf PROD.'));
    } else {
      log.info(dim('Läuft gegen das OT&E-Testsystem (keine echte Registrierung, keine Kosten). Für einen echten Kauf: --yes-live.'));
    }

    // Kostenanzeige + Verfügbarkeit aus domain.check.
    let price: number | undefined;
    const s = spinner();
    s.start('Verfügbarkeit und Preis prüfen…');
    try {
      const [check] = await client.checkDomains([fqdn]);
      s.stop('Prüfung abgeschlossen.');
      if (!check) return void die('Keine Antwort von domain.check.');
      const st = availStyle(check.avail);
      price = check.price;
      note(
        `${dim('Domain:')}   ${fqdn}\n` +
          `${dim('Status:')}   ${st.color(st.label)}\n` +
          `${dim('Preis:')}    ${price !== undefined ? `${price.toFixed(2)} EUR` : 'unbekannt'}\n` +
          `${dim('Periode:')}  ${period.api}\n` +
          `${dim('Nameserver:')} ${ns.join(', ')}`,
        live ? 'LIVE-Kauf' : 'OT&E-Testkauf',
      );
      if (check.avail !== 1 && check.avail !== 2) {
        return void die(`Domain ist nicht frei (Status: ${st.label}). Kauf abgebrochen.`, { status: 'unavailable', avail: check.avail });
      }
    } catch (e) {
      s.stop(err('Prüfung fehlgeschlagen.'));
      return void die((e as Error).message, apiErrorDetails(e));
    }

    // Doppelte Bestätigung (bei --dry-run übersprungen, weil nur Validierung).
    if (!testing) {
      if (confirmPlan.askYes) {
        const c1 = await confirm({
          message: `${fqdn} für ${period.api} registrieren${price !== undefined ? ` (~${price.toFixed(2)} EUR)` : ''}?`,
          initialValue: false,
        });
        if (isCancel(c1) || !c1) return void cancelled('Abgebrochen, nichts gekauft.');
      }

      // Die getippte Bestätigung für LIVE-Käufe lässt sich NICHT per --yes überspringen,
      // nur durch --confirm <domain> (bereits vor dem Login gegen den FQDN geprüft).
      if (live && !confirmPlan.askTyped) {
        log.info(dim(`LIVE-Kauf per --confirm ${fqdn} bestätigt.`));
      } else if (live) {
        const typed = await text({
          message: `Zur Bestätigung des LIVE-Kaufs den Domainnamen exakt eintippen (${fqdn})`,
          validate: (v) => (confirmMatches(v, fqdn) ? undefined : 'Stimmt nicht überein.'),
        });
        if (isCancel(typed)) return void cancelled('Abgebrochen, nichts gekauft.');
      }
    } else {
      log.info(dim('--dry-run: domain.create wird mit testing=true nur validiert, nichts registriert.'));
    }

    // DENIC und andere Registries prüfen die Delegation sofort. Deshalb muss die
    // INWX-Zone vor domain.create existieren, wenn das CLI-Default verwendet wird.
    if (usesDefaultInwxNameservers) {
      const zoneSpinner = spinner();
      zoneSpinner.start(testing ? 'Validiere INWX-DNS-Zone…' : 'Stelle INWX-DNS-Zone bereit…');
      try {
        const result = await client.ensureNameserverZone(fqdn, { ns, testing });
        zoneSpinner.stop(
          result === 'exists'
            ? `${ok('✓')} DNS-Zone existiert.`
            : testing
              ? `${ok('✓')} DNS-Zone kann angelegt werden (testing).`
              : `${ok('✓')} DNS-Zone angelegt.`,
        );
      } catch (e) {
        zoneSpinner.stop(err('✗ DNS-Zone konnte nicht bereitgestellt werden.'));
        return void die((e as Error).message, apiErrorDetails(e));
      }
    }

    const s2 = spinner();
    s2.start(testing ? 'Validiere Registrierung (testing)…' : 'Registriere Domain…');
    try {
      const res = await client.createDomain({
        domain: fqdn,
        period: period.api,
        registrant,
        // INWX verlangt alle vier Kontakte; ohne explizite Flags den Registranten übernehmen.
        admin: opts.admin ? Number(opts.admin) : registrant,
        tech: opts.tech ? Number(opts.tech) : registrant,
        billing: opts.billing ? Number(opts.billing) : registrant,
        ns,
        renewalMode: opts.renewalMode,
        extData,
        testing,
      });
      const diagnostic = registryDiagnostic(res);
      if (res.apiCode === 1001 || diagnostic) {
        s2.stop(warn('⚠ Auftrag angenommen, aber Registry-Verarbeitung ist ausstehend oder fehlerhaft.'));
        if (diagnostic) log.warn(warn(diagnostic));
        else if (res.apiMessage) log.warn(warn(res.apiMessage));
        jsonOut?.({ ok: false, status: 'pending', apiCode: res.apiCode, apiMessage: res.apiMessage, apiReason: res.apiReason, result: res });
        process.exitCode = 1;
        return;
      }
      s2.stop(
        testing
          ? `${ok('✓')} Validierung erfolgreich (nichts registriert).`
          : `${ok('✓')} Registriert. roId ${res.roId ?? '?'}${res.price !== undefined ? `, Kosten ${res.price} ${res.currency ?? 'EUR'}` : ''}`,
      );
      jsonOut?.({
        ok: true,
        status: testing ? 'validated' : 'registered',
        apiCode: res.apiCode,
        roId: res.roId,
        price: res.price,
        currency: res.currency,
      });
    } catch (e) {
      s2.stop(err('✗ domain.create fehlgeschlagen.'));
      return void die((e as Error).message, apiErrorDetails(e));
    }
    outro(ok('Fertig.'));
  });
}

/* ────────────────────────── contact ls ────────────────────────── */
async function cmdContactLs(): Promise<void> {
  const env = envFromOpts();
  await withClient(env, async (client) => {
    const contacts = await client.listContacts();
    console.log('');
    console.log(`  ${brand('contacts')} ${envBadge(env)}  ${dim(contacts.length + ' Kontakte')}`);
    console.log('');
    console.log(contactTable(contacts));
    console.log('');
  });
}

/* ────────────────────────── contact add ────────────────────────── */
interface ContactAddOpts {
  type?: string;
  name?: string;
  org?: string;
  street?: string;
  pc?: string;
  city?: string;
  cc?: string;
  email?: string;
  voice?: string;
}

async function cmdContactAdd(opts: ContactAddOpts = {}): Promise<void> {
  const env = envFromOpts();
  intro(`${logo()} ${dim('contact add')}  ${envBadge(env)}`);

  // Non-interaktiv, wenn alle Pflichtfelder als Flags übergeben wurden.
  const flagged = Boolean(opts.name && opts.street && opts.pc && opts.city && opts.email && opts.voice);

  let type: string;
  let name: string;
  let org: string;
  let street: string;
  let pc2: string;
  let city: string;
  let cc: string;
  let email: string;
  let voice: string;

  if (flagged) {
    type = (opts.type ?? 'person').toLowerCase();
    if (!['person', 'org', 'role'].includes(type)) return die('--type muss person, org oder role sein.');
    name = opts.name!.trim();
    org = (opts.org ?? '').trim();
    street = opts.street!.trim();
    pc2 = opts.pc!.trim();
    city = opts.city!.trim();
    try {
      cc = normalizeCountryCode(opts.cc ?? 'DE');
    } catch (e) {
      return die((e as Error).message);
    }
    email = opts.email!.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return die('--email ist keine gültige E-Mail-Adresse.');
    try {
      voice = normalizePhone(opts.voice!);
    } catch (e) {
      return die((e as Error).message);
    }
  } else {
    if (!isInteractive()) {
      const required: [keyof ContactAddOpts, string][] = [
        ['name', '--name'], ['street', '--street'], ['pc', '--pc'], ['city', '--city'], ['email', '--email'], ['voice', '--voice'],
      ];
      const missing = required.filter(([k]) => !opts[k]).map(([, flag]) => flag);
      return die(`Kein interaktives Terminal für die Rückfragen: fehlende Pflicht-Flags ${missing.join(', ')} angeben.`);
    }
    const t = await select({
      message: 'Kontakttyp',
      options: [
        { value: 'person', label: 'Person (natürliche Person)' },
        { value: 'org', label: 'Organisation / Firma' },
        { value: 'role', label: 'Rolle (z. B. Hostmaster)' },
      ],
      initialValue: opts.type ?? 'person',
    });
    if (isCancel(t)) return void cancelled('Abgebrochen.');
    type = t;

    const n = await text({ message: 'Voller Name (Vor- und Nachname)', initialValue: opts.name, validate: (v) => (v.trim() ? undefined : 'Pflichtfeld.') });
    if (isCancel(n)) return void cancelled('Abgebrochen.');
    name = n.trim();

    const o = await text({ message: 'Firma / Organisation (optional)', initialValue: opts.org, placeholder: '—' });
    if (isCancel(o)) return void cancelled('Abgebrochen.');
    org = o.trim();

    const st = await text({ message: 'Straße und Hausnummer', initialValue: opts.street, validate: (v) => (v.trim() ? undefined : 'Pflichtfeld.') });
    if (isCancel(st)) return void cancelled('Abgebrochen.');
    street = st.trim();

    const p = await text({ message: 'PLZ', initialValue: opts.pc, validate: (v) => (v.trim() ? undefined : 'Pflichtfeld.') });
    if (isCancel(p)) return void cancelled('Abgebrochen.');
    pc2 = p.trim();

    const ci = await text({ message: 'Ort', initialValue: opts.city, validate: (v) => (v.trim() ? undefined : 'Pflichtfeld.') });
    if (isCancel(ci)) return void cancelled('Abgebrochen.');
    city = ci.trim();

    const c = await text({
      message: 'Ländercode (ISO 3166-1 alpha-2, z. B. DE)',
      initialValue: opts.cc ?? 'DE',
      validate: (v) => {
        try {
          normalizeCountryCode(v);
          return undefined;
        } catch (e) {
          return (e as Error).message;
        }
      },
    });
    if (isCancel(c)) return void cancelled('Abgebrochen.');
    cc = normalizeCountryCode(c);

    const e = await text({
      message: 'E-Mail',
      initialValue: opts.email,
      validate: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()) ? undefined : 'Bitte eine gültige E-Mail.'),
    });
    if (isCancel(e)) return void cancelled('Abgebrochen.');
    email = e.trim();

    const vo = await text({
      message: 'Telefon (international, z. B. +49.30123456)',
      initialValue: opts.voice,
      validate: (v) => {
        try {
          normalizePhone(v);
          return undefined;
        } catch (e) {
          return (e as Error).message;
        }
      },
    });
    if (isCancel(vo)) return void cancelled('Abgebrochen.');
    voice = normalizePhone(vo);
  }

  await withClient(env, async (client) => {
    const s = spinner();
    s.start('Kontakt anlegen…');
    try {
      const id = await client.createContact({
        type: type as ContactType,
        name,
        org: org || undefined,
        street,
        pc: pc2,
        city,
        cc,
        email,
        voice,
      });
      s.stop(`${ok('✓')} Kontakt angelegt.`);
      note(`${dim('Kontakt-ID:')} ${accent(String(id))}\n${dim('Nutzung:')} inwx domain buy <name> --registrant ${id}`, 'Handle');
      outro(ok('Fertig.'));
    } catch (e) {
      s.stop(err('✗ Anlegen fehlgeschlagen.'));
      die((e as Error).message);
    }
  });
}

/* ────────────────────────── Programm ────────────────────────── */
/** Konfiguriert das Command-Programm (ohne es auszuführen). Auch vom Doc-Generator genutzt. */
export function buildProgram(): Command {
  program
    .name('inwx')
    .description('Schön designte CLI für INWX-Domains & -DNS (DomRobot-API).')
    .version('0.2.0')
    .option('--ote', 'gegen das INWX-OTE-Testsystem arbeiten (statt produktiv)')
    .option('--totp-code <code>', 'aktueller 6-stelliger 2FA-Code (ersetzt die 2FA-Rückfrage, z. B. ohne Terminal)');

  program
    .command('login')
    .description('Bei INWX anmelden und Zugang speichern (interaktiv oder per Flags)')
    .option('--user <name>', 'Benutzername; schaltet auf Login ohne Rückfragen')
    .option('--password-stdin', 'Passwort von stdin lesen (sonst INWX_PASSWORD)')
    .addHelpText(
      'after',
      '\nOhne Terminal: printf %s "$PW" | inwx login --user <name> --password-stdin\n' +
        '2FA: INWX_TOTP_SECRET setzen (wird gespeichert) oder einmalig --totp-code <code>.',
    )
    .action(cmdLogin);
  program.command('logout').description('Gespeicherten Zugang entfernen').action(cmdLogout);
  program.command('whoami').description('Angemeldeten Account anzeigen').action(cmdWhoami);

  const dns = program.command('dns').description('DNS-Records verwalten');
  dns.command('ls <domain>').alias('list').description('Alle Records einer Zone anzeigen').action(cmdDnsLs);
  const dnsZone = dns.command('zone').description('DNS-Zonen verwalten');
  dnsZone
    .command('add <domain>')
    .description('INWX-MASTER-Zone inklusive SOA-/NS-Basis anlegen')
    .option('--soa-email <email>', 'E-Mail-Adresse für den SOA-Record')
    .option('--dry-run', 'nur validieren (testing=true), nicht anlegen')
    .action(cmdDnsZoneAdd);
  dns
    .command('add <domain> <name> <type> <content>')
    .description('Einzelnen Record anlegen')
    .option('--ttl <sekunden>', 'TTL', '3600')
    .option('--prio <n>', 'Priorität (für MX)')
    .action(cmdDnsAdd);
  dns
    .command('rm <domain> <id>')
    .alias('remove')
    .description('Record per ID löschen')
    .option('-y, --yes', 'ohne Rückfrage (ohne Terminal Pflicht)')
    .action(cmdDnsRm);
  dns
    .command('apply <file>')
    .description('Records deklarativ aus einer JSON-Datei ausrollen (mit Plan)')
    .option('--dry-run', 'nur den Plan zeigen, nichts schreiben')
    .option('-y, --yes', 'ohne Rückfrage anwenden (ohne Terminal Pflicht)')
    .action(cmdDnsApply);

  const domain = program.command('domain').description('Domains verwalten (Verfügbarkeit, Preise, Registrierung)');
  domain
    .command('check <name...>')
    .description('Verfügbarkeit einer oder mehrerer Domains prüfen (READ-ONLY)')
    .action(cmdDomainCheck);
  domain.command('price <name>').description('Preisinfo zu einer Domain/TLD').action(cmdDomainPrice);
  domain.command('ls').alias('list').description('Eigene Domains auflisten').action(cmdDomainLs);
  domain.command('info <name>').description('Details zu einer eigenen Domain').action(cmdDomainInfo);
  domain
    .command('ns <name>')
    .description('Nameserver einer Domain aktualisieren')
    .option('--ns <liste>', 'Nameserver (kommasepariert)', DEFAULT_INWX_NAMESERVERS.join(','))
    .option('--dry-run', 'nur validieren (testing=true), nicht ändern')
    .option('-y, --yes', 'Rückfrage überspringen (ohne Terminal Pflicht)')
    .action(cmdDomainNs);
  domain
    .command('buy <name>')
    .description('Domain registrieren (Standard: OT&E-Test; PROD nur mit --yes-live)')
    .option('--period <dauer>', 'Registrierungsdauer, z. B. 1Y', '1Y')
    .option('--registrant <contactId>', 'Inhaber-Kontakt-ID (Pflicht)')
    .option('--admin <contactId>', 'Admin-C')
    .option('--tech <contactId>', 'Tech-C')
    .option('--billing <contactId>', 'Billing-C')
    .option('--ns <liste>', 'Nameserver (kommasepariert)', DEFAULT_INWX_NAMESERVERS.join(','))
    .option('--renewal-mode <modus>', 'Verlängerungsmodus (AUTORENEW, AUTOEXPIRE, AUTODELETE)')
    .option(
      '--ext <keyval>',
      'TLD-Zusatzdaten als key=value (mehrfach nutzbar)',
      (v: string, acc: string[]) => {
        acc.push(v);
        return acc;
      },
      [] as string[],
    )
    .option('--dry-run', 'nur validieren (testing=true), nicht registrieren')
    .option('-y, --yes', 'Ja/Nein-Rückfrage überspringen (LIVE braucht zusätzlich die Tippbestätigung oder --confirm)')
    .option('--yes-live', 'ECHTE, kostenpflichtige Registrierung auf PROD erlauben')
    .option('--confirm <domain>', 'ersetzt die getippte LIVE-Bestätigung; muss exakt dem Domainnamen entsprechen')
    .option('--json', 'Ergebnis als JSON auf stdout, Fortschritt auf stderr; keine Rückfragen')
    .addHelpText(
      'after',
      '\nOhne Terminal (Skript, CI, Agent) braucht ein LIVE-Kauf --yes und --confirm <domain>:\n' +
        '  inwx domain buy example.com --registrant <id> --yes-live --yes --confirm example.com\n' +
        'Fehlt eine Bestätigung ohne Terminal, bricht der Befehl mit Exit-Code 1 ab und kauft nichts.\n' +
        'Exit-Codes: 0 = registriert bzw. validiert, 1 = abgebrochen, fehlgeschlagen oder ausstehend.',
    )
    .action(cmdDomainBuy);

  const accounting = program.command('accounting').description('Buchhaltung: Rechnungen und Kontoauszug (nur lesend)');
  accounting
    .command('invoices')
    .alias('ls')
    .description('Rechnungen und Gutschriften auflisten')
    .option('--from <datum>', 'ab Datum (JJJJ-MM-TT)')
    .option('--to <datum>', 'bis Datum (JJJJ-MM-TT)')
    .option('--json', 'Ergebnis als JSON auf stdout')
    .action(cmdAccountingInvoices);
  accounting
    .command('invoice [ids...]')
    .alias('download')
    .description('Rechnungen als PDF speichern (Nummern oder Zeitraum)')
    .requiredOption('-o, --out <ordner>', 'Zielordner')
    .option('--from <datum>', 'alle Rechnungen ab Datum (statt Nummern)')
    .option('--to <datum>', 'alle Rechnungen bis Datum')
    .option('--xml', 'E-Rechnung (XML) zusätzlich speichern')
    .option('--json', 'Ergebnis als JSON auf stdout')
    .action(cmdAccountingInvoice);
  accounting
    .command('statement')
    .alias('log')
    .description('Kontoauszug: Aufladungen und Belastungen des Guthabens')
    .option('--from <datum>', 'ab Datum (JJJJ-MM-TT), Pflicht')
    .option('--to <datum>', 'bis Datum (JJJJ-MM-TT), Standard heute')
    .option('--csv <datei>', 'zusätzlich als CSV speichern (Semikolon, deutsches Komma)')
    .option('--json', 'Ergebnis als JSON auf stdout')
    .action(cmdAccountingStatement);

  const contact = program.command('contact').description('Domain-Kontakte (Handles) verwalten');
  contact.command('ls').alias('list').description('Kontakte auflisten').action(cmdContactLs);
  contact
    .command('add')
    .description('Neuen Kontakt anlegen (interaktiv oder vollständig per Flags, ohne Terminal nur per Flags)')
    .option('--type <typ>', 'person | org | role', 'person')
    .option('--name <name>', 'Voller Name (Vor- und Nachname)')
    .option('--org <org>', 'Firma / Organisation (optional)')
    .option('--street <strasse>', 'Straße und Hausnummer')
    .option('--pc <plz>', 'Postleitzahl')
    .option('--city <ort>', 'Ort')
    .option('--cc <land>', 'Ländercode ISO 3166-1 alpha-2', 'DE')
    .option('--email <email>', 'E-Mail')
    .option('--voice <telefon>', 'Telefon international, z. B. +49.30123456')
    .action(cmdContactAdd);

  return program;
}

export function run(argv: string[]): void {
  buildProgram().parseAsync(argv).catch((e) => {
    if (e instanceof ApiError) die(e.message);
    else die(e instanceof Error ? e.message : String(e));
  });
}
