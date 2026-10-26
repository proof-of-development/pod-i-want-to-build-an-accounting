'use strict';
/*
 * server.js: money-leak and ledger-consistency audit for a small or medium creative agency.
 *
 * ACCOUNT (builder)
 * - Built: one Node HTTP server that uses only the standard library and has no dependencies.
 *   It listens on port 3000 on every interface: IPv6 "::" with dual-stack, and Node falls back to 0.0.0.0
 *   when IPv6 is not available. It makes no outbound connections.
 * - Endpoint: POST /audit. The body is a JSON array of entries
 *   [{id, date, customer, type: "invoice"|"payment", amount}].
 *   The server also accepts {"entries":[...]}.
 *   It returns {"leaks":[{id, description, customer, balance, ...extra detail}], "summary":{...}}.
 *   GET / returns a short description of the service.
 * - Made outside the repository: nothing. There are no contracts, services, accounts or keys.
 * - Asked of the owner: nothing. No secret is needed or read.
 * - Not verified: I wrote this file but did not run it or any check against it.
 *   The server has not yet been started or exercised against sample requests.
 *
 * ASSUMPTIONS (the job left these open, so I chose the smallest honest reading)
 * - "balance" on every leak is that customer's net ledger balance: sum of invoices minus sum of payments.
 *   It uses the customer string exactly as written and only valid entries.
 *   A positive balance means money is owed to the agency (unpaid or short-paid work).
 *   A negative balance means the agency holds unapplied or over-received cash (a refund liability or misposting).
 * - A customer whose invoices and payments net to exactly 0 has no balance leak.
 *   Prepayments or deposits that are later invoiced are not flagged.
 * - Payments are applied first-in-first-out to the oldest open invoice.
 *   This allocation decides which invoice is "open", how old it is, and when a leak began.
 * - Ages are measured against the latest date in the submitted data, not against today.
 *   This keeps the same input producing the same output.
 * - Some entries cannot be trusted: a missing or non-numeric amount, a negative amount, an unparseable date,
 *   an unknown type, or a missing customer. These are reported as leaks and excluded from balances.
 * - Duplicate ids and same-day identical postings ARE counted in balances, because they are on the books.
 *   They are also flagged as their own leak, so the double count is visible.
 * - Zero-amount invoices are flagged, as possibly unbilled work.
 * - Name variants such as "Acme Ltd" and "acme ltd " are flagged but not merged.
 */

const http = require('http');

const PORT = 3000;
const MAX_BODY = 10 * 1024 * 1024;
const DAY = 86400000;

const toCents = (n) => Math.round(n * 100);
const fromCents = (c) => Math.round(c) / 100;
const fmt = (c) => (c < 0 ? '-' : '') + (Math.abs(c) / 100).toFixed(2);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const normName = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

function parseDate(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const t = s.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) {
    const y = +m[1], mo = +m[2] - 1, d = +m[3];
    const ms = Date.UTC(y, mo, d);
    const dt = new Date(ms);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return null;
    return ms;
  }
  const p = Date.parse(t);
  return Number.isNaN(p) ? null : p;
}

function audit(raw) {
  const leaks = [];
  const valid = [];
  const invalid = [];
  const idSeen = new Map(); // id -> first index
  const dupIdHits = [];

  raw.forEach((e, i) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      invalid.push({ index: i, id: 'entry#' + (i + 1), customer: '', problems: ['entry is not a JSON object'] });
      return;
    }
    const problems = [];
    let id = null;
    if (typeof e.id === 'string' && e.id.trim()) id = e.id;
    else if (typeof e.id === 'number' && Number.isFinite(e.id)) id = String(e.id);
    if (id === null) { problems.push('missing id'); id = 'entry#' + (i + 1); }

    const customer = typeof e.customer === 'string' ? e.customer : '';
    if (!customer.trim()) problems.push('missing customer');

    const type = typeof e.type === 'string' ? e.type.trim().toLowerCase() : '';
    if (type !== 'invoice' && type !== 'payment') problems.push('unknown type ' + JSON.stringify(e.type === undefined ? null : e.type));

    let cents = null;
    if (typeof e.amount !== 'number' || !Number.isFinite(e.amount)) problems.push('amount is not a number (' + JSON.stringify(e.amount === undefined ? null : e.amount) + ')');
    else if (e.amount < 0) problems.push('negative amount ' + e.amount + ' (credit notes/refunds must be recorded explicitly, not as negative ' + (type || 'entries') + ')');
    else cents = toCents(e.amount);

    const date = parseDate(e.date);
    if (date === null) problems.push('unparseable date ' + JSON.stringify(e.date === undefined ? null : e.date));

    if (idSeen.has(id)) dupIdHits.push({ index: i, id, firstIndex: idSeen.get(id) });
    else idSeen.set(id, i);

    if (problems.length) {
      invalid.push({ index: i, id, customer, type, amount: e.amount, date: e.date, problems });
    } else {
      valid.push({ index: i, id, customer, type, cents, date });
    }
  });

  const allDates = valid.map((r) => r.date);
  const periodStart = allDates.length ? Math.min(...allDates) : null;
  const periodEnd = allDates.length ? Math.max(...allDates) : null;
  const ageAt = (d) => (periodEnd === null || d === null ? null : Math.round((periodEnd - d) / DAY));

  // Group by exact customer string.
  const byCustomer = new Map();
  for (const r of valid) {
    if (!byCustomer.has(r.customer)) byCustomer.set(r.customer, []);
    byCustomer.get(r.customer).push(r);
  }

  const custInfo = new Map();
  const ageing = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  const allOpen = [];

  for (const [customer, recs] of byCustomer) {
    recs.sort((a, b) => a.date - b.date || a.index - b.index);
    const open = []; // invoices with remaining > 0
    const credit = []; // payments with unapplied remainder
    const invoices = [];
    let invoiced = 0, paid = 0;
    for (const r of recs) {
      if (r.type === 'invoice') {
        invoiced += r.cents;
        const inv = { id: r.id, date: r.date, original: r.cents, remaining: r.cents, paidBy: [] };
        invoices.push(inv);
        while (inv.remaining > 0 && credit.length) {
          const c = credit[0];
          const use = Math.min(c.remaining, inv.remaining);
          c.remaining -= use; inv.remaining -= use; inv.paidBy.push(c.id);
          if (c.remaining === 0) credit.shift();
        }
        if (inv.remaining > 0) open.push(inv);
      } else {
        paid += r.cents;
        let left = r.cents;
        while (left > 0 && open.length) {
          const inv = open[0];
          const use = Math.min(left, inv.remaining);
          inv.remaining -= use; left -= use; inv.paidBy.push(r.id);
          if (inv.remaining === 0) open.shift();
        }
        if (left > 0) credit.push({ id: r.id, date: r.date, original: r.cents, remaining: left });
      }
    }
    const balance = invoiced - paid;
    custInfo.set(customer, { customer, recs, invoices, open, credit, invoiced, paid, balance });
    for (const inv of open) {
      const a = ageAt(inv.date);
      const b = a <= 30 ? '0-30' : a <= 60 ? '31-60' : a <= 90 ? '61-90' : '90+';
      ageing[b] += inv.remaining;
      allOpen.push({ customer, ...inv });
    }
  }

  const balOf = (customer) => (custInfo.has(customer) ? custInfo.get(customer).balance : 0);
  const leakOrigins = []; // {date, cents, kind}

  // 1) Customer balance leaks
  for (const info of custInfo.values()) {
    if (info.balance === 0) continue;
    if (info.balance > 0) {
      const oldest = info.open[0];
      const shortPaid = info.open.filter((i) => i.remaining < i.original);
      const unpaid = info.open.filter((i) => i.remaining === i.original);
      const shortAmounts = new Map();
      for (const s of shortPaid) shortAmounts.set(s.remaining, (shortAmounts.get(s.remaining) || 0) + 1);
      const repeated = [...shortAmounts].filter(([, n]) => n >= 2);
      const lastPayment = [...info.recs].reverse().find((r) => r.type === 'payment');
      let d = `Customer "${info.customer}" owes ${fmt(info.balance)}: invoiced ${fmt(info.invoiced)}, paid ${fmt(info.paid)}. ` +
        `Outstanding since ${isoDay(oldest.date)} (invoice ${oldest.id}, ${ageAt(oldest.date)} days before the last ledger date ${isoDay(periodEnd)}). ` +
        `${info.open.length} open invoice(s): ${info.open.map((i) => `${i.id} ${isoDay(i.date)} ${fmt(i.remaining)} of ${fmt(i.original)}`).join('; ')}.`;
      if (unpaid.length) d += ` ${unpaid.length} invoice(s) have received no payment at all.`;
      if (shortPaid.length) d += ` ${shortPaid.length} invoice(s) were short-paid.`;
      if (repeated.length) d += ` Pattern: the same shortfall recurs (${repeated.map(([c, n]) => `${fmt(c)} x${n}`).join(', ')}), which points to a systematic deduction (bank/transfer fees, an unrecorded discount, or withholding) rather than a one-off.`;
      if (!lastPayment) d += ' No payment has ever been recorded for this customer.';
      else if (lastPayment.date < oldest.date) d += ` The last payment (${lastPayment.id}, ${isoDay(lastPayment.date)}) predates every open invoice, so payment stopped while billing continued.`;
      leaks.push({
        id: oldest.id, description: d, customer: info.customer, balance: fromCents(info.balance),
        kind: 'unpaid_balance', severity: ageAt(oldest.date) > 90 ? 'high' : ageAt(oldest.date) > 30 ? 'medium' : 'low',
        amount: fromCents(info.balance), since: isoDay(oldest.date), ageDays: ageAt(oldest.date),
        relatedIds: info.open.map((i) => i.id),
      });
      for (const i of info.open) leakOrigins.push({ date: i.date, cents: i.remaining, kind: 'unpaid_balance' });
    } else {
      const first = info.credit[0];
      const over = -info.balance;
      let d = `Customer "${info.customer}" has ${fmt(over)} more paid than invoiced: invoiced ${fmt(info.invoiced)}, paid ${fmt(info.paid)}. ` +
        `Unapplied cash since ${isoDay(first.date)} (payment ${first.id}): ${info.credit.map((c) => `${c.id} ${isoDay(c.date)} ${fmt(c.remaining)} unapplied of ${fmt(c.original)}`).join('; ')}. ` +
        `Possible causes: a missing invoice, a duplicated payment posting, a payment posted to the wrong customer, or a refund owed.`;
      if (info.invoiced === 0) d += ' No invoice exists for this customer at all.';
      leaks.push({
        id: first.id, description: d, customer: info.customer, balance: fromCents(info.balance),
        kind: 'overpayment', severity: 'medium', amount: fromCents(over), since: isoDay(first.date),
        ageDays: ageAt(first.date), relatedIds: info.credit.map((c) => c.id),
      });
      for (const c of info.credit) leakOrigins.push({ date: c.date, cents: c.remaining, kind: 'overpayment' });
    }
  }

  // 2) Duplicate ids
  for (const h of dupIdHits) {
    const e = raw[h.index], f = raw[h.firstIndex];
    const same = JSON.stringify([f.date, f.customer, f.type, f.amount]) === JSON.stringify([e.date, e.customer, e.type, e.amount]);
    const customer = typeof e.customer === 'string' ? e.customer : '';
    const amt = typeof e.amount === 'number' && Number.isFinite(e.amount) ? e.amount : 0;
    leaks.push({
      id: h.id,
      description: same
        ? `Entry id "${h.id}" is posted twice with identical details (${e.type} ${amt} on ${e.date}); entries #${h.firstIndex + 1} and #${h.index + 1}. Double posting inflates ${e.type === 'payment' ? 'cash received' : 'revenue billed'} by ${amt}.`
        : `Entry id "${h.id}" is reused for different entries (#${h.firstIndex + 1}: ${f.type} ${f.amount} ${f.customer} ${f.date}; #${h.index + 1}: ${e.type} ${e.amount} ${e.customer} ${e.date}). Ids must be unique; one record may have overwritten or masked another.`,
      customer, balance: fromCents(balOf(customer)), kind: same ? 'duplicate_posting' : 'duplicate_id',
      severity: 'high', amount: amt, since: typeof e.date === 'string' ? e.date : null, ageDays: ageAt(parseDate(e.date)),
      relatedIds: [h.id],
    });
    const pd = parseDate(e.date);
    if (pd !== null) leakOrigins.push({ date: pd, cents: toCents(amt), kind: same ? 'duplicate_posting' : 'duplicate_id' });
  }

  // 3) Same customer, type, amount and date under different ids
  for (const info of custInfo.values()) {
    const seen = new Map();
    for (const r of info.recs) {
      if (r.cents === 0) continue;
      const k = r.type + '|' + r.cents + '|' + r.date;
      if (seen.has(k) && seen.get(k).id !== r.id) {
        const f = seen.get(k);
        leaks.push({
          id: r.id,
          description: `Possible double entry: ${r.type} ${r.id} for "${info.customer}" duplicates ${f.id} (same amount ${fmt(r.cents)}, same date ${isoDay(r.date)}). Verify against the bank statement / source document.`,
          customer: info.customer, balance: fromCents(info.balance), kind: 'possible_double_entry', severity: 'medium',
          amount: fromCents(r.cents), since: isoDay(r.date), ageDays: ageAt(r.date), relatedIds: [f.id, r.id],
        });
        leakOrigins.push({ date: r.date, cents: r.cents, kind: 'possible_double_entry' });
      } else if (!seen.has(k)) seen.set(k, r);
    }
  }

  // 4) Zero-value invoices
  for (const r of valid) {
    if (r.type === 'invoice' && r.cents === 0) {
      leaks.push({
        id: r.id, description: `Invoice ${r.id} for "${r.customer}" on ${isoDay(r.date)} is for 0.00; work may have been delivered but not billed.`,
        customer: r.customer, balance: fromCents(balOf(r.customer)), kind: 'zero_invoice', severity: 'low',
        amount: 0, since: isoDay(r.date), ageDays: ageAt(r.date), relatedIds: [r.id],
      });
    }
  }

  // 5) Invalid / untrustworthy entries
  for (const v of invalid) {
    const amt = typeof v.amount === 'number' && Number.isFinite(v.amount) ? v.amount : 0;
    leaks.push({
      id: v.id,
      description: `Inconsistent entry #${v.index + 1} (id ${v.id}) excluded from balances: ${v.problems.join('; ')}.`,
      customer: v.customer || '', balance: fromCents(balOf(v.customer || '')), kind: 'invalid_entry', severity: 'high',
      amount: amt, since: typeof v.date === 'string' ? v.date : null, ageDays: ageAt(parseDate(v.date)), relatedIds: [v.id],
    });
    const pd = parseDate(v.date);
    if (pd !== null) leakOrigins.push({ date: pd, cents: toCents(Math.abs(amt)), kind: 'invalid_entry' });
  }

  // 6) Customer name variants
  const variants = new Map();
  for (const name of custInfo.keys()) {
    const k = normName(name);
    if (!variants.has(k)) variants.set(k, []);
    variants.get(k).push(name);
  }
  for (const names of variants.values()) {
    if (names.length < 2) continue;
    const sorted = names.map((n) => custInfo.get(n)).sort((a, b) => b.recs.length - a.recs.length);
    const combined = sorted.reduce((s, c) => s + c.balance, 0);
    for (const c of sorted.slice(1)) {
      leaks.push({
        id: c.recs[0].id,
        description: `Customer name "${c.customer}" looks like a variant of "${sorted[0].customer}" (${names.map((n) => JSON.stringify(n)).join(', ')}). ` +
          `Split records hide the true position: combined balance would be ${fmt(combined)}. Payments may have been posted against the wrong spelling.`,
        customer: c.customer, balance: fromCents(c.balance), kind: 'customer_name_variant', severity: 'medium',
        amount: fromCents(c.balance), since: isoDay(c.recs[0].date), ageDays: ageAt(c.recs[0].date),
        relatedIds: c.recs.map((r) => r.id),
      });
    }
  }

  // Summary and patterns
  const byMonth = {};
  const byKind = {};
  for (const o of leakOrigins) {
    const m = monthOf(o.date);
    byMonth[m] = byMonth[m] || { count: 0, amount: 0 };
    byMonth[m].count++; byMonth[m].amount += o.cents;
  }
  for (const l of leaks) {
    byKind[l.kind] = byKind[l.kind] || { count: 0, amount: 0 };
    byKind[l.kind].count++; byKind[l.kind].amount += toCents(Math.abs(l.amount || 0));
  }
  for (const v of Object.values(byMonth)) v.amount = fromCents(v.amount);
  for (const v of Object.values(byKind)) v.amount = fromCents(v.amount);

  const patterns = [];
  const months = Object.keys(byMonth).sort();
  if (months.length) patterns.push(`Leaks originate from ${months[0]} to ${months[months.length - 1]} (${months.length} distinct month(s)).`);
  if (months.length >= 2) {
    const top = [...months].sort((a, b) => byMonth[b].amount - byMonth[a].amount)[0];
    patterns.push(`Largest leak month: ${top} (${byMonth[top].count} item(s), ${byMonth[top].amount.toFixed(2)}).`);
  }
  const multiOpen = [...custInfo.values()].filter((c) => c.open.length >= 2);
  if (multiOpen.length) patterns.push(`Repeat non-payment: ${multiOpen.map((c) => `"${c.customer}" (${c.open.length} open invoices)`).join(', ')}. Consider credit holds before further work.`);
  const totalUnder = [...custInfo.values()].filter((c) => c.balance > 0).reduce((s, c) => s + c.balance, 0);
  const totalOver = [...custInfo.values()].filter((c) => c.balance < 0).reduce((s, c) => s - c.balance, 0);
  const topDebtor = [...custInfo.values()].sort((a, b) => b.balance - a.balance)[0];
  if (topDebtor && topDebtor.balance > 0 && totalUnder > 0) {
    patterns.push(`"${topDebtor.customer}" accounts for ${Math.round((topDebtor.balance / totalUnder) * 100)}% of money owed (${fmt(topDebtor.balance)} of ${fmt(totalUnder)}).`);
  }
  if (dupIdHits.length || byKind.possible_double_entry) patterns.push('Duplicate postings present: review the entry process (manual re-keying, imports run twice).');
  if (invalid.length) patterns.push(`${invalid.length} entr(ies) could not be trusted and were excluded; balances may change once they are corrected.`);

  const sevRank = { high: 0, medium: 1, low: 2 };
  leaks.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || Math.abs(b.amount || 0) - Math.abs(a.amount || 0));

  return {
    leaks,
    summary: {
      entries: raw.length, validEntries: valid.length, invalidEntries: invalid.length, customers: custInfo.size,
      periodStart: periodStart === null ? null : isoDay(periodStart), periodEnd: periodEnd === null ? null : isoDay(periodEnd),
      totalInvoiced: fromCents(valid.filter((r) => r.type === 'invoice').reduce((s, r) => s + r.cents, 0)),
      totalPaid: fromCents(valid.filter((r) => r.type === 'payment').reduce((s, r) => s + r.cents, 0)),
      totalOwedToAgency: fromCents(totalUnder), totalOverReceived: fromCents(totalOver),
      earliestLeak: leakOrigins.length ? isoDay(Math.min(...leakOrigins.map((o) => o.date))) : null,
      ageingOfOpenInvoices: Object.fromEntries(Object.entries(ageing).map(([k, v]) => [k, fromCents(v)])),
      leaksByOriginMonth: byMonth, leaksByKind: byKind, patterns,
      assumptions: [
        'balance = invoices minus payments per exact customer name (positive: owed to agency; negative: over-received).',
        'Payments applied FIFO to oldest open invoice; ages measured against the latest date in the data.',
        'Invalid entries are excluded from balances; duplicate postings are included and flagged.',
      ],
    },
  };
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (path === '/' && req.method === 'GET') {
    return send(res, 200, {
      service: 'agency ledger audit',
      usage: 'POST /audit with a JSON array of {id, date, customer, type: "invoice"|"payment", amount}',
      returns: '{ leaks: [{id, description, customer, balance, kind, severity, amount, since, ageDays, relatedIds}], summary }',
    });
  }
  if (path !== '/audit') return send(res, 404, { error: 'not found', leaks: [] });
  if (req.method !== 'POST') return send(res, 405, { error: 'use POST', leaks: [] });

  const chunks = [];
  let size = 0, aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > MAX_BODY) { aborted = true; send(res, 413, { error: 'body too large', leaks: [] }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return;
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); }
    catch (e) { return send(res, 400, { error: 'invalid JSON: ' + e.message, leaks: [] }); }
    const entries = Array.isArray(data) ? data : data && Array.isArray(data.entries) ? data.entries : null;
    if (!entries) return send(res, 400, { error: 'body must be a JSON array of entries (or {"entries": [...]})', leaks: [] });
    try { send(res, 200, audit(entries)); }
    catch (e) { send(res, 500, { error: 'audit failed: ' + e.message, leaks: [] }); }
  });
  req.on('error', () => { if (!aborted) { aborted = true; try { send(res, 400, { error: 'request error', leaks: [] }); } catch (_) {} } });
});

// No host argument: Node binds every interface (IPv6 "::" dual-stack, or 0.0.0.0 when IPv6 is unavailable).
server.listen(PORT, () => {
  console.log(`audit server listening on port ${PORT} on all interfaces`);
});
