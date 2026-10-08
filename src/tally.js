// Low-level TallyPrime XML-over-HTTP client, plus builders/parsers for vouchers and masters.
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

export const config = {
  host: process.env.TALLY_HOST || 'localhost',
  port: process.env.TALLY_PORT || '9000',
  timeoutMs: Number(process.env.TALLY_TIMEOUT_MS || 180000),
  readOnly: /^(1|true|yes)$/i.test(process.env.TALLY_READONLY || ''),
  defaultCompany: process.env.TALLY_COMPANY || '',
};

// ---------------------------------------------------------------- helpers

export const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export const fmt = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);
const round2 = (n) => Math.round(n * 100) / 100;
export const num = (s) => {
  const v = parseFloat(String(s ?? '').replace(/,/g, ''));
  return Number.isFinite(v) ? v : 0;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Accepts YYYY-MM-DD, YYYYMMDD, DD-MM-YYYY, DD/MM/YYYY, 1-Apr-2024. Returns {y,m,d}. */
export function parseDate(input) {
  const s = String(input ?? '').trim();
  let y, m, d, mt;
  if ((mt = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/))) [, y, m, d] = mt.map(Number);
  else if ((mt = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) [, d, m, y] = mt.map(Number);
  else if ((mt = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{4})$/))) {
    d = Number(mt[1]);
    m = MONTHS.findIndex((x) => x.toLowerCase() === mt[2].toLowerCase()) + 1;
    y = Number(mt[3]);
  }
  const dt = y && m && d ? new Date(Date.UTC(y, m - 1, d)) : null;
  if (!dt || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
    throw new Error(`Invalid date "${input}". Use YYYY-MM-DD (e.g. 2025-04-01).`);
  return { y, m, d };
}
const pad = (n) => String(n).padStart(2, '0');
export const compactDate = (s) => { const { y, m, d } = parseDate(s); return `${y}${pad(m)}${pad(d)}`; };
export const tallyDate = (s) => { const { y, m, d } = parseDate(s); return `${d}-${MONTHS[m - 1]}-${y}`; };
export const isoDate = (s) => { if (!s) return ''; try { const { y, m, d } = parseDate(s); return `${y}-${pad(m)}-${pad(d)}`; } catch { return String(s); } };

// Tally sometimes emits control-char references like &#4; which are not legal XML 1.0.
const sanitize = (s) =>
  s.replace(/&#(x[0-9a-f]+|\d+);/gi, (m, g) => {
    const n = g[0].toLowerCase() === 'x' ? parseInt(g.slice(1), 16) : parseInt(g, 10);
    return n < 32 && n !== 9 && n !== 10 && n !== 13 ? '' : m;
  });

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  htmlEntities: true,
  isArray: (name) => name.endsWith('.LIST'),
});

// Order-preserving parser/builder used to edit an exported voucher and send it back unchanged otherwise.
const poOpts = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
};
const poParser = new XMLParser(poOpts);
const poBuilder = new XMLBuilder({ ...poOpts, suppressEmptyNode: false, format: false });

export const txt = (x) => {
  if (x == null) return '';
  if (Array.isArray(x)) return txt(x[0]);
  if (typeof x === 'object') return String(x['#text'] ?? '').trim();
  return String(x).trim();
};
export const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

function deepFind(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const r = deepFind(v, key);
    if (r !== undefined) return r;
  }
  return undefined;
}

// ---------------------------------------------------------------- transport

function decode(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b.length >= 4 && b[1] === 0 && b[3] === 0) return new TextDecoder('utf-16le').decode(b);
  return new TextDecoder('utf-8').decode(b);
}

export async function postXml(xml) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);
  try {
    const res = await fetch(`http://${config.host}:${config.port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml;charset=utf-8' },
      body: xml,
      signal: ctrl.signal,
    });
    const text = decode(await res.arrayBuffer());
    if (!res.ok) throw new Error(`Tally returned HTTP ${res.status}: ${text.slice(0, 500)}`);
    return text;
  } catch (e) {
    if (e.name === 'AbortError')
      throw new Error(`Tally did not respond within ${config.timeoutMs / 1000}s at ${config.host}:${config.port}.`);
    if (e.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(e.message))
      throw new Error(
        `Cannot connect to Tally at ${config.host}:${config.port}. Open TallyPrime, load a company, and enable ` +
          `F1 > Settings > Connectivity > "TallyPrime acts as" = Server or Both, port ${config.port}.`
      );
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function ping() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`http://${config.host}:${config.port}`, { signal: ctrl.signal });
    return (await res.text()).replace(/<[^>]+>/g, '').trim();
  } finally {
    clearTimeout(timer);
  }
}

function throwOnLineError(resp) {
  const m = resp.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/);
  if (m) throw new Error(`Tally error: ${m[1].trim()}`);
}

function staticVars({ company, from, to } = {}) {
  let s = '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>';
  const co = company || config.defaultCompany;
  if (co) s += `<SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY>`;
  if (from) s += `<SVFROMDATE TYPE="Date">${tallyDate(from)}</SVFROMDATE>`;
  if (to) s += `<SVTODATE TYPE="Date">${tallyDate(to)}</SVTODATE>`;
  return `<STATICVARIABLES>${s}</STATICVARIABLES>`;
}

// ---------------------------------------------------------------- exports (reads)

/**
 * Export an ad-hoc TDL collection. `fields` are Tally native method names (e.g. Name, Parent, ClosingBalance).
 * Returns rows keyed by lower-cased field name.
 */
export function collectionRequest({ type, methods, filters = [], company, from, to, childOf, belongsTo }) {
  const id = 'MCPCollection';
  const fnames = filters.map((_, i) => `MCPFilter${i}`);
  return (
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>` +
    `<BODY><DESC>${staticVars({ company, from, to })}<TDL><TDLMESSAGE>` +
    `<COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${esc(type)}</TYPE>` +
    (childOf ? `<CHILDOF>${esc(childOf)}</CHILDOF>` : '') +
    (belongsTo ? '<BELONGSTO>Yes</BELONGSTO>' : '') +
    methods.map((m) => `<NATIVEMETHOD>${m}</NATIVEMETHOD>`).join('') +
    (fnames.length ? `<FILTER>${fnames.join(', ')}</FILTER>` : '') +
    `</COLLECTION>` +
    filters.map((f, i) => `<SYSTEM TYPE="Formulae" NAME="${fnames[i]}">${esc(f)}</SYSTEM>`).join('') +
    `</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`
  );
}

export async function exportCollection({ type, fields, filters = [], company, from, to, childOf, belongsTo }) {
  const resp = await postXml(collectionRequest({ type, methods: [fields.join(', ')], filters, company, from, to, childOf, belongsTo }));
  throwOnLineError(resp);
  const coll = deepFind(parser.parse(sanitize(resp)), 'COLLECTION');
  if (!coll || typeof coll !== 'object') return [];
  const rows = [];
  for (const [tag, items] of Object.entries(coll)) {
    if (tag.startsWith('@_') || tag === '#text') continue;
    for (const it of arr(items)) {
      const row = {};
      for (const f of fields) {
        const key = f.toUpperCase();
        let v = it?.[key];
        if (v === undefined && key === 'NAME') v = it?.['@_NAME'] ?? txt(it?.['NAME.LIST']?.[0]?.NAME);
        row[f.toLowerCase()] = txt(v);
      }
      rows.push(row);
    }
  }
  return rows;
}

// TDL can't compare $Date against a date literal reliably, so filter on a numeric YYYYMMDD key.
const DATE_KEY = '(($$YearOfDate:$Date) * 10000 + ($$MonthOfDate:$Date) * 100 + ($$DayOfDate:$Date))';
export const tdlStr = (s) => `"${String(s).replace(/"/g, '')}"`;

// Nested lists are only exported when asked for explicitly.
const ENTRY_SUBLISTS = ['BillAllocations', 'BankAllocations', 'CategoryAllocations', 'CategoryAllocations.CostCentreAllocations', 'RateDetails'];
const VOUCHER_METHODS = [
  '*',
  ...['AllLedgerEntries', 'LedgerEntries'].flatMap((l) => [`${l}.*`, ...ENTRY_SUBLISTS.map((x) => `${l}.${x}.*`)]),
  ...['AllInventoryEntries', 'InventoryEntriesIn', 'InventoryEntriesOut'].flatMap((l) => [
    `${l}.*`,
    `${l}.BatchAllocations.*`,
    `${l}.AccountingAllocations.*`,
    `${l}.RateDetails.*`,
  ]),
];

/** Tally ignores sub-year periods when choosing which books to scan, so widen to whole (April-March) financial years. */
function fyPeriod(from, to) {
  if (!from && !to) return {};
  const f = parseDate(from || to), t = parseDate(to || from);
  const fy = f.m >= 4 ? f.y : f.y - 1;
  const ty = t.m >= 4 ? t.y + 1 : t.y;
  return { from: `${fy}-04-01`, to: `${ty}-03-31` };
}

/**
 * Export vouchers as full objects in Tally's import format. SVFROMDATE/SVTODATE only pick the financial
 * year(s) Tally scans; the exact date range is applied by a TDL filter.
 */
export async function exportVouchersRaw({ company, from, to, masterId, guid, voucherType, voucherNumber }) {
  const filters = [];
  if (from) filters.push(`${DATE_KEY} >= ${compactDate(from)}`);
  if (to) filters.push(`${DATE_KEY} <= ${compactDate(to)}`);
  if (masterId) filters.push(`$MasterID = ${Number(masterId)}`);
  if (guid) filters.push(`$GUID = ${tdlStr(guid)}`);
  if (voucherType) filters.push(`$VoucherTypeName = ${tdlStr(voucherType)}`);
  if (voucherNumber != null) filters.push(`$VoucherNumber = ${tdlStr(voucherNumber)}`);
  const resp = await postXml(collectionRequest({ type: 'Voucher', methods: VOUCHER_METHODS, filters, company, ...fyPeriod(from, to) }));
  throwOnLineError(resp);
  return (resp.match(/<VOUCHER\s[^>]*>[\s\S]*?<\/VOUCHER>/g) || []).map(normalizeVoucherRaw);
}

/**
 * Keep only the entry lists Tally itself uses on import: invoices carry LEDGERENTRIES + ALLINVENTORYENTRIES
 * (ALLLEDGERENTRIES is a derived duplicate); accounting vouchers carry ALLLEDGERENTRIES only.
 */
function normalizeVoucherRaw(raw) {
  const invoice = /<PERSISTEDVIEW>Invoice Voucher View<\/PERSISTEDVIEW>/.test(raw) || /<ISINVOICE>Yes<\/ISINVOICE>/.test(raw);
  const drop = invoice ? 'ALLLEDGERENTRIES' : 'LEDGERENTRIES';
  let out = raw.replace(new RegExp(`\\s*<${drop}\\.LIST>[\\s\\S]*?</${drop}\\.LIST>`, 'g'), '');
  if (!invoice) {
    // accounting vouchers come back with empty inventory placeholders
    out = out.replace(/\s*<ALLINVENTORYENTRIES\.LIST>(?:(?!<STOCKITEMNAME>)[\s\S])*?<\/ALLINVENTORYENTRIES\.LIST>/g, '');
  }
  return out;
}

/** Turn a raw exported voucher into a compact JSON summary. */
export function summarizeVoucher(raw) {
  const v = parser.parse(sanitize(raw)).VOUCHER || {};
  const mapBills = (le) =>
    arr(le['BILLALLOCATIONS.LIST'])
      .filter((b) => txt(b.NAME))
      .map((b) => ({ name: txt(b.NAME), type: txt(b.BILLTYPE), amount: Math.abs(num(txt(b.AMOUNT))) }));
  const mapCC = (le) =>
    arr(le['CATEGORYALLOCATIONS.LIST']).flatMap((c) =>
      arr(c['COSTCENTREALLOCATIONS.LIST'])
        .filter((cc) => txt(cc.NAME))
        .map((cc) => ({ category: txt(c.CATEGORY), name: txt(cc.NAME), amount: Math.abs(num(txt(cc.AMOUNT))) }))
    );
  const ledger_entries = [...arr(v['ALLLEDGERENTRIES.LIST']), ...arr(v['LEDGERENTRIES.LIST'])]
    .filter((le) => txt(le.LEDGERNAME))
    .map((le) => {
      const a = num(txt(le.AMOUNT));
      const e = { ledger: txt(le.LEDGERNAME), type: a < 0 ? 'Dr' : 'Cr', amount: Math.abs(a) };
      if (txt(le.ISPARTYLEDGER) === 'Yes') e.is_party = true;
      const bills = mapBills(le);
      if (bills.length) e.bill_allocations = bills;
      const cc = mapCC(le);
      if (cc.length) e.cost_centres = cc;
      return e;
    });
  const inventory_entries = [...arr(v['ALLINVENTORYENTRIES.LIST']), ...arr(v['INVENTORYENTRIES.LIST'])]
    .filter((ie) => txt(ie.STOCKITEMNAME))
    .map((ie) => {
      const a = num(txt(ie.AMOUNT));
      return {
        item: txt(ie.STOCKITEMNAME),
        quantity: txt(ie.BILLEDQTY) || txt(ie.ACTUALQTY),
        rate: txt(ie.RATE),
        amount: Math.abs(a),
        direction: a < 0 ? 'in' : 'out',
        ledger: arr(ie['ACCOUNTINGALLOCATIONS.LIST']).map((x) => txt(x.LEDGERNAME)).filter(Boolean).join(', '),
        godown: arr(ie['BATCHALLOCATIONS.LIST']).map((x) => txt(x.GODOWNNAME)).filter(Boolean).join(', ') || undefined,
      };
    });
  const sjLines = (list) =>
    arr(v[list])
      .filter((ie) => txt(ie.STOCKITEMNAME))
      .map((ie) => ({
        item: txt(ie.STOCKITEMNAME),
        quantity: txt(ie.BILLEDQTY) || txt(ie.ACTUALQTY),
        rate: txt(ie.RATE) || undefined,
        amount: Math.abs(num(txt(ie.AMOUNT))),
        godown: arr(ie['BATCHALLOCATIONS.LIST']).map((x) => txt(x.GODOWNNAME)).filter(Boolean).join(', ') || undefined,
      }));
  const stock_in = sjLines('INVENTORYENTRIESIN.LIST');
  const stock_out = sjLines('INVENTORYENTRIESOUT.LIST');
  let dr = 0, cr = 0;
  for (const e of ledger_entries) e.type === 'Dr' ? (dr += e.amount) : (cr += e.amount);
  for (const e of inventory_entries) e.direction === 'in' ? (dr += e.amount) : (cr += e.amount);
  return {
    master_id: txt(v.MASTERID),
    guid: txt(v.GUID) || v['@_REMOTEID'] || '',
    date: isoDate(txt(v.DATE)),
    voucher_type: txt(v.VOUCHERTYPENAME) || v['@_VCHTYPE'] || '',
    voucher_number: txt(v.VOUCHERNUMBER),
    reference: txt(v.REFERENCE) || undefined,
    party_ledger: txt(v.PARTYLEDGERNAME) || undefined,
    narration: txt(v.NARRATION) || undefined,
    amount: round2(Math.max(dr, cr, ...[stock_in, stock_out].map((l) => l.reduce((a, e) => a + e.amount, 0)))),
    is_invoice: txt(v.ISINVOICE) === 'Yes' || txt(v.PERSISTEDVIEW) === 'Invoice Voucher View',
    is_cancelled: txt(v.ISCANCELLED) === 'Yes' || undefined,
    is_optional: txt(v.ISOPTIONAL) === 'Yes' || undefined,
    ledger_entries,
    // stock journals also expose their lines through ALLINVENTORYENTRIES; show them once, as stock_in/stock_out
    inventory_entries: inventory_entries.length && !stock_in.length && !stock_out.length ? inventory_entries : undefined,
    stock_in: stock_in.length ? stock_in : undefined,
    stock_out: stock_out.length ? stock_out : undefined,
  };
}

// ---------------------------------------------------------------- imports (writes)

export function parseImportResponse(resp) {
  const n = (tag) => {
    const m = resp.match(new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`));
    return m ? Number(m[1]) : 0;
  };
  const errorMessages = [...resp.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/g)].map((m) => m[1].trim());
  return {
    created: n('CREATED'),
    altered: n('ALTERED'),
    deleted: n('DELETED'),
    combined: n('COMBINED'),
    ignored: n('IGNORED'),
    errors: n('ERRORS'),
    cancelled: n('CANCELLED'),
    exceptions: n('EXCEPTIONS'),
    last_voucher_id: n('LASTVCHID') || undefined,
    last_master_id: n('LASTMID') || undefined,
    error_messages: errorMessages.length ? errorMessages : undefined,
  };
}

export function importEnvelope(reportName, company, body) {
  const co = company || config.defaultCompany;
  return (
    `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC>` +
    `<REPORTNAME>${reportName}</REPORTNAME>` +
    (co ? `<STATICVARIABLES><SVCURRENTCOMPANY>${esc(co)}</SVCURRENTCOMPANY></STATICVARIABLES>` : '') +
    `</REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallySchema">${body}</TALLYMESSAGE>` +
    `</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`
  );
}

export function assertWritable() {
  if (config.readOnly) throw new Error('This server is running with TALLY_READONLY=true; write operations are disabled.');
}

export async function importData(reportName, company, body) {
  assertWritable();
  return parseImportResponse(await postXml(importEnvelope(reportName, company, body)));
}

// ---------------------------------------------------------------- voucher XML building

const INV_OUT = /sales|debit\s*note|delivery|rejection\s*out|material\s*out/i;
const INV_IN = /purchase|credit\s*note|receipt\s*note|rejection\s*in|material\s*in/i;

function inventoryDirection(entry, voucherType) {
  if (entry.direction) return entry.direction;
  // check "purchase" first so e.g. "Purchase Return" style custom names don't fall through to sales
  if (INV_IN.test(voucherType)) return 'in';
  if (INV_OUT.test(voucherType)) return 'out';
  throw new Error(
    `Cannot infer stock direction for voucher type "${voucherType}". Set direction: "in" or "out" on each inventory entry.`
  );
}

function ledgerEntryXml(e, listTag, isParty) {
  const dr = e.type === 'Dr';
  const signed = dr ? -Math.abs(e.amount) : Math.abs(e.amount);
  const deemed = dr ? 'Yes' : 'No';
  let x = `<${listTag}><LEDGERNAME>${esc(e.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE>`;
  x += `<ISPARTYLEDGER>${isParty ? 'Yes' : 'No'}</ISPARTYLEDGER><AMOUNT>${fmt(signed)}</AMOUNT>`;
  for (const b of e.bill_allocations || []) {
    const ba = b.amount != null ? (dr ? -Math.abs(b.amount) : Math.abs(b.amount)) : signed;
    x += `<BILLALLOCATIONS.LIST><NAME>${esc(b.name)}</NAME><BILLTYPE>${esc(b.type || 'New Ref')}</BILLTYPE>`;
    if (b.credit_days) x += `<BILLCREDITPERIOD>${Number(b.credit_days)} Days</BILLCREDITPERIOD>`;
    x += `<AMOUNT>${fmt(ba)}</AMOUNT></BILLALLOCATIONS.LIST>`;
  }
  const byCat = new Map();
  for (const c of e.cost_centres || []) {
    const cat = c.category || 'Primary Cost Category';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(c);
  }
  for (const [cat, list] of byCat) {
    x += `<CATEGORYALLOCATIONS.LIST><CATEGORY>${esc(cat)}</CATEGORY><ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE>`;
    for (const c of list) {
      const ca = c.amount != null ? (dr ? -Math.abs(c.amount) : Math.abs(c.amount)) : signed;
      x += `<COSTCENTREALLOCATIONS.LIST><NAME>${esc(c.name)}</NAME><AMOUNT>${fmt(ca)}</AMOUNT></COSTCENTREALLOCATIONS.LIST>`;
    }
    x += `</CATEGORYALLOCATIONS.LIST>`;
  }
  return x + `</${listTag}>`;
}

function inventoryEntryXml(e, voucherType) {
  const dir = inventoryDirection(e, voucherType);
  const amt = e.amount != null ? Math.abs(e.amount) : round2(Math.abs(e.quantity * e.rate) * (1 - (e.discount_percent || 0) / 100));
  const signed = dir === 'in' ? -amt : amt;
  const deemed = dir === 'in' ? 'Yes' : 'No';
  const unit = e.unit ? ` ${e.unit}` : '';
  const qty = `${e.quantity}${unit}`;
  let x = `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${esc(e.item)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE>`;
  x += `<RATE>${esc(e.rate)}${e.unit ? '/' + esc(e.unit) : ''}</RATE>`;
  if (e.discount_percent) x += `<DISCOUNT>${Number(e.discount_percent)}</DISCOUNT>`;
  x += `<AMOUNT>${fmt(signed)}</AMOUNT><ACTUALQTY>${esc(qty)}</ACTUALQTY><BILLEDQTY>${esc(qty)}</BILLEDQTY>`;
  if (e.godown || e.batch) {
    x += `<BATCHALLOCATIONS.LIST><GODOWNNAME>${esc(e.godown || 'Main Location')}</GODOWNNAME>`;
    x += `<BATCHNAME>${esc(e.batch || 'Primary Batch')}</BATCHNAME><AMOUNT>${fmt(signed)}</AMOUNT>`;
    x += `<ACTUALQTY>${esc(qty)}</ACTUALQTY><BILLEDQTY>${esc(qty)}</BILLEDQTY></BATCHALLOCATIONS.LIST>`;
  }
  x += `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${esc(e.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE>`;
  x += `<AMOUNT>${fmt(signed)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`;
  return { xml: x, dr: dir === 'in' ? amt : 0, cr: dir === 'out' ? amt : 0 };
}

/** Stock Journal line: INVENTORYENTRIESIN (production / destination) or INVENTORYENTRIESOUT (consumption / source). */
function stockJournalEntryXml(e, dir) {
  const listTag = dir === 'in' ? 'INVENTORYENTRIESIN.LIST' : 'INVENTORYENTRIESOUT.LIST';
  const amt = e.amount != null ? Math.abs(e.amount) : round2(Math.abs(e.quantity * (e.rate || 0)));
  const signed = dir === 'in' ? -amt : amt;
  const qty = `${e.quantity}${e.unit ? ' ' + e.unit : ''}`;
  let x = `<${listTag}><STOCKITEMNAME>${esc(e.item)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>${dir === 'in' ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`;
  if (e.rate != null) x += `<RATE>${esc(e.rate)}${e.unit ? '/' + esc(e.unit) : ''}</RATE>`;
  x += `<AMOUNT>${fmt(signed)}</AMOUNT><ACTUALQTY>${esc(qty)}</ACTUALQTY><BILLEDQTY>${esc(qty)}</BILLEDQTY>`;
  x += `<BATCHALLOCATIONS.LIST><GODOWNNAME>${esc(e.godown || 'Main Location')}</GODOWNNAME><BATCHNAME>${esc(e.batch || 'Primary Batch')}</BATCHNAME>`;
  x += `<AMOUNT>${fmt(signed)}</AMOUNT><ACTUALQTY>${esc(qty)}</ACTUALQTY><BILLEDQTY>${esc(qty)}</BILLEDQTY></BATCHALLOCATIONS.LIST>`;
  return x + `</${listTag}>`;
}

function checkBalanced(dr, cr) {
  if (Math.abs(round2(dr) - round2(cr)) >= 0.01)
    throw new Error(
      `Voucher is not balanced: total Debit ${fmt(dr)} vs total Credit ${fmt(cr)} (difference ${fmt(dr - cr)}). ` +
        `Add/adjust entries (e.g. a Round Off ledger) so Debit equals Credit.`
    );
}

function validateLedgerEntries(entries) {
  for (const e of entries) {
    if (!e.ledger) throw new Error('Every ledger entry needs a ledger name.');
    if (!(Number(e.amount) > 0)) throw new Error(`Ledger entry "${e.ledger}" needs a positive amount (use type Dr/Cr for direction).`);
  }
}

/** Build the <VOUCHER> element for a brand-new voucher. */
export function buildNewVoucherXml(v) {
  const ledgerEntries = v.ledger_entries || [];
  const invEntries = v.inventory_entries || [];
  validateLedgerEntries(ledgerEntries);
  if (v.stock_in?.length || v.stock_out?.length) return buildStockJournalXml(v);
  if (!ledgerEntries.length && !invEntries.length) throw new Error('Provide at least ledger_entries.');
  const isInvoice = invEntries.length > 0;
  const view = isInvoice ? 'Invoice Voucher View' : 'Accounting Voucher View';
  const leTag = isInvoice ? 'LEDGERENTRIES.LIST' : 'ALLLEDGERENTRIES.LIST';
  const party = v.party_ledger || ledgerEntries.find((e) => e.is_party)?.ledger;

  let dr = 0, cr = 0, body = '';
  for (const ie of invEntries) {
    const r = inventoryEntryXml(ie, v.base_type || v.voucher_type);
    body += r.xml; dr += r.dr; cr += r.cr;
  }
  for (const le of ledgerEntries) {
    body += ledgerEntryXml(le, leTag, le.is_party || (party && le.ledger === party));
    le.type === 'Dr' ? (dr += Number(le.amount)) : (cr += Number(le.amount));
  }
  checkBalanced(dr, cr);

  const d = compactDate(v.date);
  let x = `<VOUCHER VCHTYPE="${esc(v.voucher_type)}" ACTION="Create" OBJVIEW="${view}">`;
  x += `<DATE>${d}</DATE><EFFECTIVEDATE>${d}</EFFECTIVEDATE><VOUCHERTYPENAME>${esc(v.voucher_type)}</VOUCHERTYPENAME>`;
  if (v.voucher_number) x += `<VOUCHERNUMBER>${esc(v.voucher_number)}</VOUCHERNUMBER>`;
  if (v.reference) x += `<REFERENCE>${esc(v.reference)}</REFERENCE>`;
  if (v.reference_date) x += `<REFERENCEDATE>${compactDate(v.reference_date)}</REFERENCEDATE>`;
  if (party) x += `<PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME>` + (isInvoice ? `<PARTYNAME>${esc(party)}</PARTYNAME>` : '');
  if (v.narration) x += `<NARRATION>${esc(v.narration)}</NARRATION>`;
  x += `<PERSISTEDVIEW>${view}</PERSISTEDVIEW>`;
  if (isInvoice) x += '<ISINVOICE>Yes</ISINVOICE>';
  if (v.is_optional) x += '<ISOPTIONAL>Yes</ISOPTIONAL>';
  x += body + (v.extra_xml || '') + '</VOUCHER>';
  return x;
}

function buildStockJournalXml(v) {
  const view = 'Consumption Voucher View';
  const d = compactDate(v.date);
  let x = `<VOUCHER VCHTYPE="${esc(v.voucher_type)}" ACTION="Create" OBJVIEW="${view}">`;
  x += `<DATE>${d}</DATE><EFFECTIVEDATE>${d}</EFFECTIVEDATE><VOUCHERTYPENAME>${esc(v.voucher_type)}</VOUCHERTYPENAME>`;
  if (v.voucher_number) x += `<VOUCHERNUMBER>${esc(v.voucher_number)}</VOUCHERNUMBER>`;
  if (v.narration) x += `<NARRATION>${esc(v.narration)}</NARRATION>`;
  x += `<PERSISTEDVIEW>${view}</PERSISTEDVIEW>`;
  for (const e of v.stock_out || []) x += stockJournalEntryXml(e, 'out');
  for (const e of v.stock_in || []) x += stockJournalEntryXml(e, 'in');
  return x + (v.extra_xml || '') + '</VOUCHER>';
}

// ---------------------------------------------------------------- locate / modify existing vouchers

/**
 * Find one voucher. ref = { master_id } | { guid } | { date, voucher_number, voucher_type? }.
 * Returns { raw, summary, sameNumberCount }.
 */
export async function findVoucher(company, ref) {
  let date = ref.date;
  const idFilter = ref.master_id ? { masterId: ref.master_id } : ref.guid ? { guid: ref.guid } : null;
  if (idFilter) {
    // Find the voucher's date first: current financial year (fast), then all years (slower, ~10s on big books).
    const fields = ['Date', 'GUID', 'MasterID'];
    const match = (r) => (ref.master_id ? r.masterid === String(ref.master_id) : r.guid === ref.guid);
    let row = (await exportCollection({ type: 'Voucher', fields, company })).find(match);
    if (!row) row = (await exportCollection({ type: 'Voucher', fields, company, from: '1990-01-01', to: '2099-12-31' })).find(match);
    if (!row) throw new Error(`No voucher found with ${ref.master_id ? 'master_id ' + ref.master_id : 'guid ' + ref.guid}.`);
    date = row.date;
  }
  if (!date) throw new Error('Identify the voucher by master_id, guid, or date + voucher_number.');
  const raws = await exportVouchersRaw({
    company,
    from: date,
    to: date,
    ...(idFilter || { voucherNumber: ref.voucher_number, voucherType: ref.voucher_type }),
  });
  const matches = raws.map((raw) => ({ raw, summary: summarizeVoucher(raw) }));
  if (!matches.length) throw new Error(`Voucher not found on ${isoDate(date)}.`);
  if (matches.length > 1)
    throw new Error(
      `More than one voucher matches (${matches.map((m) => `${m.summary.voucher_type} #${m.summary.voucher_number} master_id=${m.summary.master_id}`).join('; ')}). Use master_id instead.`
    );
  return matches[0];
}

const keyOf = (node) => Object.keys(node).find((k) => k !== ':@');
const textNode = (value) => [{ '#text': esc(value) }];

function setField(children, tag, value) {
  const node = children.find((c) => keyOf(c) === tag);
  if (node) node[tag] = textNode(value);
  else children.unshift({ [tag]: textNode(value) });
}

function replaceLists(children, removeTags, newXmlFragments) {
  let insertAt = children.findIndex((c) => removeTags.includes(keyOf(c)));
  const kept = children.filter((c) => !removeTags.includes(keyOf(c)));
  if (insertAt < 0) insertAt = kept.length;
  else insertAt = children.slice(0, insertAt).filter((c) => !removeTags.includes(keyOf(c))).length;
  const newNodes = newXmlFragments.flatMap((f) => poParser.parse(f));
  kept.splice(insertAt, 0, ...newNodes);
  return kept;
}

/**
 * Apply changes to a raw exported voucher and return a new <VOUCHER ACTION="Alter"> XML string.
 * Fields not mentioned in `changes` are sent back exactly as Tally exported them.
 */
export function buildAlteredVoucherXml(raw, summary, changes, { attrs } = {}) {
  const doc = poParser.parse(raw);
  const vnode = doc.find((n) => keyOf(n) === 'VOUCHER');
  if (!vnode) throw new Error('Could not parse exported voucher.');
  let children = vnode.VOUCHER;
  const at = (vnode[':@'] ||= {});
  at['@_ACTION'] = 'Alter';
  delete at['@_REMOTEID'];
  delete at['@_VCHKEY'];
  if (attrs) Object.assign(at, attrs);

  if (changes.date) {
    const d = compactDate(changes.date);
    setField(children, 'DATE', d);
    setField(children, 'EFFECTIVEDATE', d);
  }
  if (changes.voucher_number != null) setField(children, 'VOUCHERNUMBER', changes.voucher_number);
  if (changes.reference != null) setField(children, 'REFERENCE', changes.reference);
  if (changes.reference_date) setField(children, 'REFERENCEDATE', compactDate(changes.reference_date));
  if (changes.narration != null) setField(children, 'NARRATION', changes.narration);
  if (changes.party_ledger) {
    setField(children, 'PARTYLEDGERNAME', changes.party_ledger);
    if (summary.is_invoice) setField(children, 'PARTYNAME', changes.party_ledger);
  }
  for (const [k, val] of Object.entries(changes.set_fields || {})) setField(children, k.toUpperCase(), val);

  if (changes.stock_in) children = replaceLists(children, ['INVENTORYENTRIESIN.LIST'], changes.stock_in.map((e) => stockJournalEntryXml(e, 'in')));
  if (changes.stock_out) children = replaceLists(children, ['INVENTORYENTRIESOUT.LIST'], changes.stock_out.map((e) => stockJournalEntryXml(e, 'out')));

  const newLedger = changes.ledger_entries;
  const newInv = changes.inventory_entries;
  if (newLedger || newInv) {
    const party = changes.party_ledger || summary.party_ledger;
    let dr = 0, cr = 0;
    if (newInv) {
      const frags = newInv.map((ie) => inventoryEntryXml(ie, changes.base_type || summary.voucher_type));
      frags.forEach((f) => { dr += f.dr; cr += f.cr; });
      children = replaceLists(children, ['ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST'], frags.map((f) => f.xml));
    } else {
      for (const ie of summary.inventory_entries || []) ie.direction === 'in' ? (dr += ie.amount) : (cr += ie.amount);
    }
    if (newLedger) {
      validateLedgerEntries(newLedger);
      const leTag = summary.is_invoice || newInv?.length ? 'LEDGERENTRIES.LIST' : 'ALLLEDGERENTRIES.LIST';
      const frags = newLedger.map((le) => {
        // carry an existing single bill reference forward if the caller didn't specify bills for this ledger
        if (le.bill_allocations === undefined) {
          const old = summary.ledger_entries.find((o) => o.ledger === le.ledger && o.bill_allocations?.length === 1);
          if (old) le = { ...le, bill_allocations: [{ name: old.bill_allocations[0].name, type: old.bill_allocations[0].type }] };
        }
        le.type === 'Dr' ? (dr += Number(le.amount)) : (cr += Number(le.amount));
        return ledgerEntryXml(le, leTag, le.is_party || (party && le.ledger === party));
      });
      children = replaceLists(children, ['ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST'], frags);
    } else {
      for (const le of summary.ledger_entries) le.type === 'Dr' ? (dr += le.amount) : (cr += le.amount);
    }
    checkBalanced(dr, cr);
  }
  vnode.VOUCHER = children;
  return poBuilder.build([vnode]);
}

// Tested on TallyPrime: matching an existing voucher by REMOTEID creates a duplicate instead of altering it,
// while DATE + "Voucher Number" + VCHTYPE identifies it correctly for both Alter and Delete.
export function voucherNumberAttrs(summary) {
  return {
    '@_DATE': tallyDate(summary.date),
    '@_TAGNAME': 'Voucher Number',
    '@_TAGVALUE': esc(summary.voucher_number),
    '@_VCHTYPE': esc(summary.voucher_type),
  };
}

async function assertUniquelyNumbered(company, s) {
  if (!s.voucher_number)
    throw new Error('This voucher has no voucher number, so Tally cannot identify it for alteration/deletion over XML. Give it a number in Tally first.');
  const same = await exportVouchersRaw({ company, from: s.date, to: s.date, voucherType: s.voucher_type, voucherNumber: s.voucher_number });
  if (same.length !== 1)
    throw new Error(
      `${same.length} "${s.voucher_type}" vouchers numbered "${s.voucher_number}" exist on ${s.date}; Tally cannot tell them apart. ` +
        'Renumber one of them in Tally first.'
    );
}

/** Alter an existing voucher. Fields not in `changes` are sent back exactly as Tally holds them. */
export async function alterVoucher(company, ref, changes, { dryRun } = {}) {
  const found = await findVoucher(company, ref);
  const before = found.summary;
  await assertUniquelyNumbered(company, before);
  if (changes.inventory_entries?.some((e) => !e.direction))
    changes = { ...changes, base_type: await voucherBaseType(company, before.voucher_type) };
  const xml = buildAlteredVoucherXml(found.raw, before, changes, { attrs: voucherNumberAttrs(before) });
  if (dryRun) return { dry_run: true, before, xml: importEnvelope('Vouchers', company, xml) };
  const result = explain(await importData('Vouchers', company, xml));
  const out = { result, before };
  if (result.created > 0)
    out.warning = `Tally CREATED a new voucher (master_id ${result.last_voucher_id}) instead of altering. Check for a duplicate.`;
  if (result.altered > 0) out.after = (await findVoucher(company, { master_id: before.master_id })).summary;
  return out;
}

export async function deleteVoucher(company, ref, { dryRun } = {}) {
  const { summary } = await findVoucher(company, ref);
  await assertUniquelyNumbered(company, summary);
  const a = voucherNumberAttrs(summary);
  const xml = `<VOUCHER DATE="${a['@_DATE']}" TAGNAME="Voucher Number" TAGVALUE="${a['@_TAGVALUE']}" VCHTYPE="${a['@_VCHTYPE']}" ACTION="Delete"></VOUCHER>`;
  if (dryRun) return { dry_run: true, voucher: summary, xml: importEnvelope('Vouchers', company, xml) };
  return { result: explain(await importData('Vouchers', company, xml)), deleted_voucher: summary };
}

/** Add plain-language hints to common Tally import errors. */
export function explain(result) {
  const hints = [];
  for (const m of result.error_messages || []) {
    if (/date is missing/i.test(m))
      hints.push(
        'Tally rejected the date. Either it is outside the company books period, or Tally is running in Educational mode ' +
          '(which only accepts dates on the 1st, 2nd and 31st of a month).'
      );
    if (/does not exist|could not find/i.test(m)) hints.push('A ledger, stock item, unit, godown or voucher type name does not match Tally exactly (names are case-sensitive in some places).');
    if (/negative stock/i.test(m)) hints.push('The item would go into negative stock; check quantities or enable negative stock in Tally.');
  }
  if (hints.length) result.hints = [...new Set(hints)];
  return result;
}

/**
 * Export full objects of a master type (import format, nested lists included when named in `methods`).
 * Returns { raw, obj } per object; obj is parsed with *.LIST tags as arrays.
 */
export async function exportMasterObjects({ type, methods = ['*'], filters = [], company }) {
  const resp = await postXml(collectionRequest({ type, methods, filters, company }));
  throwOnLineError(resp);
  const tag = type.toUpperCase();
  const raws = resp.match(new RegExp(`<${tag}\\s[^>]*>[\\s\\S]*?</${tag}>`, 'g')) || [];
  return raws.map((raw) => ({ raw, obj: parser.parse(sanitize(raw))[tag] || {} }));
}

/** Base (predefined) voucher type for a possibly custom voucher type, e.g. "SALES GST-RD" -> "Sales". */
export async function voucherBaseType(company, name) {
  const rows = await exportCollection({ type: 'VoucherType', fields: ['Name', 'Parent'], company, filters: [`$Name = ${tdlStr(name)}`] });
  if (!rows.length) throw new Error(`Voucher type "${name}" does not exist in the company.`);
  return rows[0].parent || name;
}
