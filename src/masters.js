// Masters (ledgers, groups, stock items, stock groups, units, godowns, cost centres) in TallyPrime 3+ format:
// names in LANGUAGENAME.LIST, ledger address in LEDMAILINGDETAILS.LIST, ledger GST in LEDGSTREGDETAILS.LIST,
// item GST in GSTDETAILS.LIST and HSN in HSNDETAILS.LIST. Alter merges with the existing values, then sends
// complete detail blocks so a partial change never blanks other fields.
import {
  esc, fmt, txt, arr, num, tdlStr,
  exportCollection, exportMasterObjects, importData, importEnvelope, explain,
} from './tally.js';

export const MASTER_TYPES = {
  ledger: 'Ledger',
  group: 'Group',
  stock_item: 'StockItem',
  stock_group: 'StockGroup',
  unit: 'Unit',
  godown: 'Godown',
  cost_centre: 'CostCentre',
};
const TAG = (type) => MASTER_TYPES[type].toUpperCase();
const RESERVED = '&#4; '; // Tally's prefix for built-in values such as "Primary", "Any", "Applicable"

const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const yn = (b) => (b ? 'Yes' : 'No');
const tag = (name, value) => (value === undefined || value === null || value === '' ? '' : `<${name}>${esc(value)}</${name}>`);
const namesXml = (name, aliases = []) =>
  `<LANGUAGENAME.LIST><NAME.LIST TYPE="String">${[name, ...aliases].map((n) => `<NAME>${esc(n)}</NAME>`).join('')}</NAME.LIST>` +
  `<LANGUAGEID> 1033</LANGUAGEID></LANGUAGENAME.LIST>`;
const parentXml = (parent) =>
  parent === undefined ? '' : /^primary$/i.test(parent) || parent === '' ? `<PARENT>${RESERVED}Primary</PARENT>` : `<PARENT>${esc(parent)}</PARENT>`;
const lastOf = (list) => arr(list).filter((x) => x && typeof x === 'object').slice(-1)[0] || {};
const names = (obj) => arr(lastOf(obj['LANGUAGENAME.LIST'])['NAME.LIST']).flatMap((n) => arr(n.NAME).map(txt));
const plain = (s) => String(s || '').replace(/^\s*/, '').trim();

const booksFromCache = new Map();
async function booksFrom(company) {
  const key = company || '';
  if (!booksFromCache.has(key)) {
    const rows = await exportCollection({ type: 'Company', fields: ['Name', 'BooksFrom'], company });
    const row = (company && rows.find((r) => r.name === company)) || rows[0];
    booksFromCache.set(key, row?.booksfrom || '20170701');
  }
  return booksFromCache.get(key);
}

// ---------------------------------------------------------------- read

const METHODS = {
  ledger: ['*', 'LanguageName.*', 'LedMailingDetails.*', 'LedMailingDetails.Address.*', 'LedGSTRegDetails.*'],
  stock_item: ['*', 'LanguageName.*', 'BatchAllocations.*', 'GSTDetails.*', 'GSTDetails.StateWiseDetails.*', 'GSTDetails.StateWiseDetails.RateDetails.*', 'HSNDetails.*'],
};

async function fetchMaster(company, type, name) {
  const found = await exportMasterObjects({
    type: MASTER_TYPES[type],
    methods: METHODS[type] || ['*', 'LanguageName.*'],
    filters: [`$Name = ${tdlStr(name)}`],
    company,
  });
  return found[0]?.obj;
}

function ledgerDetails(o) {
  const m = lastOf(o['LEDMAILINGDETAILS.LIST']);
  const g = lastOf(o['LEDGSTREGDETAILS.LIST']);
  const ob = num(txt(o.OPENINGBALANCE));
  return defined({
    name: o['@_NAME'],
    aliases: names(o).slice(1),
    group: plain(txt(o.PARENT)),
    opening_balance: Math.abs(ob),
    opening_type: ob < 0 ? 'Dr' : 'Cr',
    maintain_bill_wise: txt(o.ISBILLWISEON) === 'Yes',
    credit_days: parseInt(txt(o.BILLCREDITPERIOD)) || undefined,
    mailing_name: txt(m.MAILINGNAME) || undefined,
    address: arr(lastOf(m['ADDRESS.LIST']).ADDRESS).map(txt).filter(Boolean),
    state: txt(m.STATE) || txt(o.PRIORSTATENAME) || undefined,
    country: txt(m.COUNTRY) || txt(o.COUNTRYOFRESIDENCE) || undefined,
    pincode: txt(m.PINCODE) || undefined,
    gstin: txt(g.GSTIN) || undefined,
    gst_registration_type: txt(g.GSTREGISTRATIONTYPE) || undefined,
    place_of_supply: txt(g.PLACEOFSUPPLY) || undefined,
    pan: txt(o.INCOMETAXNUMBER) || undefined,
    email: txt(o.EMAIL) || undefined,
    phone: txt(o.LEDGERPHONE) || undefined,
    mobile: txt(o.LEDGERMOBILE) || undefined,
    contact_person: txt(o.LEDGERCONTACT) || undefined,
    _mailing_from: txt(m.APPLICABLEFROM) || undefined,
    _gst_from: txt(g.APPLICABLEFROM) || undefined,
  });
}

function stockItemDetails(o) {
  const g = lastOf(o['GSTDETAILS.LIST']);
  const rates = arr(lastOf(g['STATEWISEDETAILS.LIST'])['RATEDETAILS.LIST']);
  const rate = (head) => num(txt(rates.find((r) => txt(r.GSTRATEDUTYHEAD) === head)?.GSTRATE)) || undefined;
  const h = lastOf(o['HSNDETAILS.LIST']);
  const qty = plain(txt(o.OPENINGBALANCE));
  const batches = arr(o['BATCHALLOCATIONS.LIST']).filter((b) => txt(b.GODOWNNAME));
  return defined({
    name: o['@_NAME'],
    aliases: names(o).slice(1),
    group: plain(txt(o.PARENT)) || 'Primary',
    category: /not applicable/i.test(txt(o.CATEGORY)) ? undefined : plain(txt(o.CATEGORY)) || undefined,
    unit: txt(o.BASEUNITS) || undefined,
    opening_quantity: qty ? num(qty) : undefined,
    opening_rate: num(txt(o.OPENINGRATE)) || undefined,
    opening_value: Math.abs(num(txt(o.OPENINGVALUE))) || undefined,
    opening_godown: batches.length === 1 ? txt(batches[0].GODOWNNAME) : undefined,
    opening_by_godown: batches.length > 1
      ? batches.map((b) => ({ godown: txt(b.GODOWNNAME), batch: txt(b.BATCHNAME), quantity: num(plain(txt(b.OPENINGBALANCE))), value: Math.abs(num(txt(b.OPENINGVALUE))) }))
      : undefined,
    description: txt(o.DESCRIPTION) || undefined,
    gst_applicable: /applicable/i.test(txt(o.GSTAPPLICABLE)) && !/not/i.test(txt(o.GSTAPPLICABLE)),
    taxability: txt(g.TAXABILITY) || undefined,
    gst_rate: rate('IGST'),
    cess_rate: rate('Cess'),
    hsn_code: txt(h.HSNCODE) || undefined,
    hsn_description: txt(h.HSN) || undefined,
    _gst_from: txt(g.APPLICABLEFROM) || undefined,
    _hsn_from: txt(h.APPLICABLEFROM) || undefined,
  });
}

function basicDetails(o) {
  return defined({
    name: o['@_NAME'] || txt(o.NAME),
    aliases: names(o).slice(1),
    parent: plain(txt(o.PARENT)) || undefined,
    category: /not applicable/i.test(txt(o.CATEGORY)) ? undefined : plain(txt(o.CATEGORY)) || undefined,
    formal_name: txt(o.ORIGINALNAME) || undefined,
    decimal_places: o.DECIMALPLACES !== undefined ? num(txt(o.DECIMALPLACES)) : undefined,
  });
}

export async function getMaster(company, type, name) {
  const o = await fetchMaster(company, type, name);
  if (!o) throw new Error(`No ${type.replace('_', ' ')} named "${name}" in Tally.`);
  if (type === 'ledger') return ledgerDetails(o);
  if (type === 'stock_item') return stockItemDetails(o);
  return basicDetails(o);
}

// ---------------------------------------------------------------- XML builders (full values, not deltas)

function ledgerXml(action, currentName, d, from) {
  let x = `<LEDGER NAME="${esc(currentName)}" ACTION="${action}">`;
  x += namesXml(d.name, d.aliases);
  x += parentXml(d.group);
  if (d.opening_balance !== undefined) x += `<OPENINGBALANCE>${fmt((d.opening_type || 'Dr') === 'Dr' ? -d.opening_balance : d.opening_balance)}</OPENINGBALANCE>`;
  if (d.maintain_bill_wise !== undefined) x += `<ISBILLWISEON>${yn(d.maintain_bill_wise)}</ISBILLWISEON>`;
  if (d.credit_days) x += `<BILLCREDITPERIOD>${Number(d.credit_days)} Days</BILLCREDITPERIOD>`;
  x += tag('INCOMETAXNUMBER', d.pan) + tag('EMAIL', d.email) + tag('LEDGERPHONE', d.phone) + tag('LEDGERMOBILE', d.mobile) + tag('LEDGERCONTACT', d.contact_person);
  x += tag('PRIORSTATENAME', d.state) + tag('COUNTRYOFRESIDENCE', d.country);
  if (d.mailing_name || d.address?.length || d.state || d.pincode || d.country) {
    x += `<LEDMAILINGDETAILS.LIST>`;
    if (d.address?.length) x += `<ADDRESS.LIST TYPE="String">${d.address.map((a) => `<ADDRESS>${esc(a)}</ADDRESS>`).join('')}</ADDRESS.LIST>`;
    x += `<APPLICABLEFROM>${d._mailing_from || from}</APPLICABLEFROM>`;
    x += tag('PINCODE', d.pincode) + tag('MAILINGNAME', d.mailing_name || d.name) + tag('STATE', d.state) + tag('COUNTRY', d.country || (d.state ? 'India' : undefined));
    x += `</LEDMAILINGDETAILS.LIST>`;
  }
  if (d.gstin || d.gst_registration_type || d.place_of_supply) {
    x += `<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>${d._gst_from || from}</APPLICABLEFROM>`;
    x += tag('GSTREGISTRATIONTYPE', d.gst_registration_type || (d.gstin ? 'Regular' : undefined));
    x += tag('PLACEOFSUPPLY', d.place_of_supply || d.state) + tag('GSTIN', d.gstin);
    x += `</LEDGSTREGDETAILS.LIST>`;
  }
  return x + (d.extra_xml || '') + '</LEDGER>';
}

function stockItemXml(action, currentName, d, from) {
  let x = `<STOCKITEM NAME="${esc(currentName)}" ACTION="${action}">`;
  x += namesXml(d.name, d.aliases);
  x += parentXml(d.group);
  if (d.category) x += parentXml(d.category).replace(/PARENT/g, 'CATEGORY');
  x += tag('BASEUNITS', d.unit) + tag('DESCRIPTION', d.description);
  if (d.opening_quantity !== undefined) {
    const u = d.unit ? ` ${d.unit}` : '';
    x += `<OPENINGBALANCE> ${d.opening_quantity}${esc(u)}</OPENINGBALANCE>`;
    const value = d.opening_value ?? (d.opening_rate !== undefined ? d.opening_quantity * d.opening_rate : undefined);
    const rateXml = d.opening_rate !== undefined ? `<OPENINGRATE>${d.opening_rate}${d.unit ? '/' + esc(d.unit) : ''}</OPENINGRATE>` : '';
    const valueXml = value !== undefined ? `<OPENINGVALUE>${fmt(-Math.abs(value))}</OPENINGVALUE>` : '';
    x += rateXml + valueXml;
    // Tally keeps the opening stock per godown/batch; the item-level figures alone are ignored on alter.
    x += `<BATCHALLOCATIONS.LIST><GODOWNNAME>${esc(d.opening_godown || 'Main Location')}</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME>`;
    x += `<OPENINGBALANCE> ${d.opening_quantity}${esc(u)}</OPENINGBALANCE>${valueXml}${rateXml}</BATCHALLOCATIONS.LIST>`;
  }
  if (d.gst_rate !== undefined || d.taxability) {
    x += `<GSTAPPLICABLE>${RESERVED}Applicable</GSTAPPLICABLE><GSTTYPEOFSUPPLY>Goods</GSTTYPEOFSUPPLY>`;
    const r = Number(d.gst_rate || 0);
    const rd = (head, rate) =>
      `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>${head}</GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>` +
      (rate ? `<GSTRATE>${rate}</GSTRATE>` : '') + `</RATEDETAILS.LIST>`;
    x += `<GSTDETAILS.LIST><APPLICABLEFROM>${d._gst_from || from}</APPLICABLEFROM><CALCULATIONTYPE>On Value</CALCULATIONTYPE>`;
    x += `<TAXABILITY>${esc(d.taxability || 'Taxable')}</TAXABILITY><SRCOFGSTDETAILS>Specify Details Here</SRCOFGSTDETAILS>`;
    x += `<STATEWISEDETAILS.LIST><STATENAME>${RESERVED}Any</STATENAME>`;
    x += rd('CGST', r / 2) + rd('SGST/UTGST', r / 2) + rd('IGST', r) + rd('Cess', d.cess_rate);
    x += `</STATEWISEDETAILS.LIST></GSTDETAILS.LIST>`;
  }
  if (d.hsn_code || d.hsn_description) {
    x += `<HSNDETAILS.LIST><APPLICABLEFROM>${d._hsn_from || from}</APPLICABLEFROM>`;
    x += tag('HSNCODE', d.hsn_code) + tag('HSN', d.hsn_description) + `<SRCOFHSNDETAILS>Specify Details Here</SRCOFHSNDETAILS></HSNDETAILS.LIST>`;
  }
  return x + (d.extra_xml || '') + '</STOCKITEM>';
}

function basicXml(type, action, currentName, d) {
  const T = TAG(type);
  let x = `<${T} NAME="${esc(currentName)}" ACTION="${action}">`;
  if (type === 'unit') {
    x += `<NAME>${esc(d.name)}</NAME>` + tag('ORIGINALNAME', d.formal_name) + `<ISSIMPLEUNIT>Yes</ISSIMPLEUNIT>`;
    if (d.decimal_places !== undefined) x += `<DECIMALPLACES>${Number(d.decimal_places)}</DECIMALPLACES>`;
  } else {
    x += namesXml(d.name, d.aliases) + parentXml(d.parent);
    if (type === 'stock_group' && action === 'Create') x += '<ISADDABLE>Yes</ISADDABLE>';
    if (type === 'cost_centre') x += `<CATEGORY>${esc(d.category || 'Primary Cost Category')}</CATEGORY>`;
  }
  return x + (d.extra_xml || '') + `</${T}>`;
}

function buildXml(type, action, currentName, d, from) {
  if (type === 'ledger') return ledgerXml(action, currentName, d, from);
  if (type === 'stock_item') return stockItemXml(action, currentName, d, from);
  return basicXml(type, action, currentName, d);
}

// ---------------------------------------------------------------- write

async function send(company, xml, dryRun) {
  if (dryRun) return { dry_run: true, xml: importEnvelope('All Masters', company, xml) };
  return explain(await importData('All Masters', company, xml));
}

export async function createMaster(company, type, fields, { dryRun } = {}) {
  if (await fetchMaster(company, type, fields.name)) throw new Error(`A ${type.replace('_', ' ')} named "${fields.name}" already exists.`);
  const xml = buildXml(type, 'Create', fields.name, defined(fields), await booksFrom(company));
  const result = await send(company, xml, dryRun);
  if (dryRun) return result;
  const out = { success: result.created > 0, result };
  if (out.success) out.saved = await getMaster(company, type, fields.name).catch(() => undefined);
  return out;
}

/** Alter: merge changes into the current values and send the complete master. `new_name` renames. */
export async function alterMaster(company, type, name, changes, { dryRun } = {}) {
  const current = await getMaster(company, type, name);
  const merged = { ...current, ...defined(changes), name: changes.new_name || current.name };
  delete merged.new_name;
  // opening value follows quantity x rate unless the caller sets it explicitly
  if (type === 'stock_item') {
    const openingChanged = ['opening_quantity', 'opening_rate', 'opening_value', 'opening_godown'].some((k) => changes[k] !== undefined);
    if (openingChanged && current.opening_by_godown)
      throw new Error('This item has opening stock in several godowns/batches; change its opening balance inside Tally.');
    if ((changes.opening_quantity !== undefined || changes.opening_rate !== undefined) && changes.opening_value === undefined) delete merged.opening_value;
    // only resend the opening block when it is being changed
    if (!openingChanged) delete merged.opening_quantity;
    delete merged.opening_by_godown;
  }
  const xml = buildXml(type, 'Alter', current.name, merged, await booksFrom(company));
  const result = await send(company, xml, dryRun);
  if (dryRun) return { ...result, before: current };
  const out = { success: result.altered > 0, result, before: current };
  if (out.success) out.after = await getMaster(company, type, merged.name).catch(() => undefined);
  return out;
}

export async function deleteMaster(company, type, name, { dryRun } = {}) {
  const current = await getMaster(company, type, name);
  const T = TAG(type);
  const xml = `<${T} NAME="${esc(current.name)}" ACTION="Delete">` +
    (type === 'unit' ? `<NAME>${esc(current.name)}</NAME>` : `<NAME.LIST TYPE="String"><NAME>${esc(current.name)}</NAME></NAME.LIST>`) +
    `</${T}>`;
  const result = await send(company, xml, dryRun);
  if (dryRun) return { ...result, master: current };
  return { success: result.deleted > 0, result, deleted: current };
}

export async function listMasters(company, type, { parent, search } = {}) {
  const fields = type === 'unit' ? ['Name', 'OriginalName', 'DecimalPlaces'] : ['Name', 'Parent'];
  let rows = await exportCollection({ type: MASTER_TYPES[type], fields, company, childOf: parent, belongsTo: !!parent });
  if (search) rows = rows.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()));
  return rows.map((r) => defined({ name: r.name, parent: r.parent !== undefined ? plain(r.parent) : undefined, formal_name: r.originalname, decimal_places: r.decimalplaces }));
}
