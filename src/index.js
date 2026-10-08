#!/usr/bin/env node
// MCP server for TallyPrime: read data and create / alter / delete vouchers and masters over Tally's XML port.
// Every write first copies the company data folder to Desktop\Tally Backups (see backup.js).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as T from './tally.js';
import * as M from './masters.js';
import { backupCompany, backupConfig, listBackups } from './backup.js';

const server = new McpServer({ name: 'tally-write-mcp', version: '1.1.0' });

const ok = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `Error: ${e?.message || e}` }] });
const tool = (name, description, schema, handler) =>
  server.registerTool(name, { description, inputSchema: schema }, async (args) => {
    try {
      return ok(await handler(args));
    } catch (e) {
      return fail(e);
    }
  });

/**
 * Register a tool that changes Tally data: refuses in read-only mode and takes a data backup first.
 * `gate` may return a response (e.g. a confirmation request) that stops the call before anything is backed up or written.
 */
const writeTool = (name, description, schema, handler, gate) =>
  tool(name, description, schema, async (args) => {
    if (gate) {
      const stop = await gate(args);
      if (stop) return stop;
    }
    if (args.dry_run) return handler(args);
    T.assertWritable();
    const backup = backupConfig.enabled ? await backupCompany(args.company, name) : 'auto-backup disabled';
    const result = await handler(args);
    return result && typeof result === 'object' && !Array.isArray(result) ? { ...result, backup } : { result, backup };
  });

// ---------------------------------------------------------------- shared schemas

const company = z.string().optional().describe('Company name as shown in Tally. Omit to use the currently active company.');
const dryRun = z.boolean().optional().describe('If true, only return the XML that would be sent; nothing is written to Tally and no backup is taken.');
const date = (what) => z.string().describe(`${what} (YYYY-MM-DD)`);

const billAllocation = z.object({
  name: z.string().describe('Bill / invoice reference number'),
  type: z.enum(['New Ref', 'Agst Ref', 'Advance', 'On Account']).optional().describe('Default "New Ref"'),
  amount: z.number().positive().optional().describe('Defaults to the full entry amount'),
  credit_days: z.number().int().optional(),
});
const costCentre = z.object({
  name: z.string(),
  amount: z.number().positive().optional().describe('Defaults to the full entry amount'),
  category: z.string().optional().describe('Default "Primary Cost Category"'),
});
const ledgerEntry = z.object({
  ledger: z.string().describe('Exact ledger name in Tally'),
  type: z.enum(['Dr', 'Cr']).describe('Debit or Credit'),
  amount: z.number().positive(),
  is_party: z.boolean().optional().describe('Mark the party (debtor/creditor) ledger'),
  bill_allocations: z.array(billAllocation).optional().describe('Bill-wise references (for bill-wise ledgers)'),
  cost_centres: z.array(costCentre).optional(),
});
const inventoryEntry = z.object({
  item: z.string().describe('Exact stock item name'),
  quantity: z.number().positive(),
  rate: z.number().nonnegative(),
  unit: z.string().optional().describe('Unit symbol, e.g. "KG", "Nos". Recommended.'),
  amount: z.number().positive().optional().describe('Defaults to quantity x rate (less discount)'),
  discount_percent: z.number().min(0).max(100).optional(),
  ledger: z.string().describe('Sales / purchase ledger the item amount posts to'),
  godown: z.string().optional(),
  batch: z.string().optional(),
  direction: z
    .enum(['in', 'out'])
    .optional()
    .describe('Stock in (purchase, credit note) or out (sales, debit note). Inferred from the voucher type when omitted.'),
});
const stockLine = z.object({
  item: z.string().describe('Exact stock item name'),
  quantity: z.number().positive(),
  unit: z.string().optional().describe('Unit symbol, e.g. "KG"'),
  rate: z.number().nonnegative().optional(),
  amount: z.number().nonnegative().optional().describe('Defaults to quantity x rate'),
  godown: z.string().optional().describe('Default "Main Location"'),
  batch: z.string().optional(),
});
const voucherRef = {
  master_id: z.union([z.string(), z.number()]).optional().describe('Voucher master_id (from list_vouchers / get_voucher). Preferred.'),
  guid: z.string().optional(),
  date: z.string().optional().describe('With voucher_number: voucher date (YYYY-MM-DD)'),
  voucher_number: z.string().optional(),
  voucher_type: z.string().optional(),
};
const refOf = (a) => ({ master_id: a.master_id, guid: a.guid, date: a.date, voucher_number: a.voucher_number, voucher_type: a.voucher_type });
const masterType = z.enum(Object.keys(M.MASTER_TYPES));
const aliases = z.array(z.string()).optional().describe('Alias names');

// ---------------------------------------------------------------- read tools

tool('tally_status', 'Check the connection to TallyPrime, list loaded companies and show backup settings.', {}, async () => {
  const status = await T.ping();
  const companies = await T.exportCollection({ type: 'Company', fields: ['Name', 'BooksFrom', 'Destination'] });
  return {
    status,
    host: `${T.config.host}:${T.config.port}`,
    read_only: T.config.readOnly,
    auto_backup: backupConfig.enabled ? { folder: backupConfig.dir, keep_last: backupConfig.keep || 'all' } : false,
    companies: companies.map((c) => ({ name: c.name, books_from: T.isoDate(c.booksfrom), data_folder: c.destination })),
  };
});

tool(
  'list_ledgers',
  'List ledgers with their group and opening/closing balance (positive = Cr, negative = Dr as Tally reports).',
  {
    company,
    group: z.string().optional().describe('Only ledgers under this group (including sub-groups), e.g. "Sundry Debtors"'),
    search: z.string().optional().describe('Case-insensitive name filter'),
  },
  async ({ company, group, search }) => {
    let rows = await T.exportCollection({ type: 'Ledger', fields: ['Name', 'Parent', 'OpeningBalance', 'ClosingBalance'], company, childOf: group, belongsTo: !!group });
    if (search) rows = rows.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()));
    return rows.map((r) => ({ name: r.name, group: r.parent, opening_balance: Number(r.openingbalance || 0), closing_balance: Number(r.closingbalance || 0) }));
  }
);

tool(
  'list_stock_items',
  'List stock items with group, base unit and closing quantity/value.',
  { company, search: z.string().optional() },
  async ({ company, search }) => {
    let rows = await T.exportCollection({ type: 'StockItem', fields: ['Name', 'Parent', 'BaseUnits', 'ClosingBalance', 'ClosingValue'], company });
    if (search) rows = rows.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()));
    return rows.map((r) => ({ name: r.name, group: r.parent.replace(/^\W+/, ''), unit: r.baseunits, closing_qty: r.closingbalance.trim(), closing_value: Math.abs(Number(r.closingvalue || 0)) }));
  }
);

tool(
  'list_masters',
  'List masters of a type: group, stock_group, godown, unit, cost_centre (also ledger / stock_item, names only).',
  { company, type: masterType, parent: z.string().optional().describe('Only those under this parent'), search: z.string().optional() },
  (a) => M.listMasters(a.company, a.type, { parent: a.parent, search: a.search })
);

tool(
  'get_master',
  'Full details of one master. Ledger: group, opening balance, bill-wise, address, state, pincode, GSTIN, PAN, contacts. ' +
    'Stock item: group, unit, opening stock, GST rate, HSN. Others: parent etc.',
  { company, type: masterType, name: z.string() },
  (a) => M.getMaster(a.company, a.type, a.name)
);

tool('list_voucher_types', 'List voucher types with their base type (e.g. "SALES GST-RD" -> Sales).', { company }, async ({ company }) =>
  (await T.exportCollection({ type: 'VoucherType', fields: ['Name', 'Parent'], company })).map((r) => ({ name: r.name, base_type: r.parent }))
);

tool(
  'list_vouchers',
  'List vouchers in a date range with their entries. Each row has master_id, which alter_voucher / delete_voucher use. ' +
    'Roughly 5 seconds per month of data, so keep ranges short.',
  {
    company,
    from: date('Start date'),
    to: date('End date'),
    voucher_type: z.string().optional().describe('Exact voucher type name, e.g. "Sales" or "SALES GST-RD"'),
    ledger: z.string().optional().describe('Only vouchers that touch this ledger (case-insensitive contains)'),
    item: z.string().optional().describe('Only vouchers with this stock item (case-insensitive contains)'),
    search: z.string().optional().describe('Text to find in narration, reference or voucher number'),
    limit: z.number().int().positive().max(2000).optional().describe('Default 200'),
  },
  async ({ company, from, to, voucher_type, ledger, item, search, limit = 200 }) => {
    let rows = (await T.exportVouchersRaw({ company, from, to, voucherType: voucher_type })).map(T.summarizeVoucher);
    const has = (v, s) => v && v.toLowerCase().includes(s.toLowerCase());
    if (ledger) rows = rows.filter((v) => v.ledger_entries.some((e) => has(e.ledger, ledger)) || (v.inventory_entries || []).some((e) => has(e.ledger, ledger)));
    if (item) rows = rows.filter((v) => [...(v.inventory_entries || []), ...(v.stock_in || []), ...(v.stock_out || [])].some((e) => has(e.item, item)));
    if (search) rows = rows.filter((v) => [v.narration, v.reference, v.voucher_number].some((x) => has(x, search)));
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return { total: rows.length, returned: Math.min(rows.length, limit), vouchers: rows.slice(0, limit) };
  }
);

tool(
  'get_voucher',
  'Get one voucher in full by master_id (or guid, or date + voucher_number + voucher_type).',
  { company, ...voucherRef, include_xml: z.boolean().optional().describe('Also return the raw Tally XML') },
  async (a) => {
    const { raw, summary } = await T.findVoucher(a.company, refOf(a));
    return a.include_xml ? { ...summary, xml: raw } : summary;
  }
);

// ---------------------------------------------------------------- backups

tool(
  'list_backups',
  'List the automatic/manual data backups (newest first) with their folders.',
  {},
  async () => ({ folder: backupConfig.dir, backups: listBackups() })
);

tool(
  'backup_data',
  'Take a backup of the company data folder now (copied to Desktop\\Tally Backups). Write tools already do this automatically.',
  { company },
  async (a) => ({ backup: await backupCompany(a.company, 'manual') })
);

// ---------------------------------------------------------------- voucher writes

writeTool(
  'create_voucher',
  'Create a voucher in Tally (Payment, Receipt, Journal, Contra, Sales, Purchase, Credit/Debit Note, Stock Journal or any custom type). ' +
    'Accounting vouchers: give ledger_entries only (Debits must equal Credits). ' +
    'Item invoices: give inventory_entries (stock items, each posting to a sales/purchase ledger) plus ledger_entries for the party ' +
    'and any tax / round-off ledgers; items count as Cr when going out (sales) and Dr when coming in (purchase). ' +
    'Stock Journal (godown transfer, manufacturing, adjustment): give stock_out (source/consumption) and/or stock_in (destination/production). ' +
    'GST is not computed automatically: pass CGST/SGST/IGST ledger lines with amounts.',
  {
    company,
    date: date('Voucher date'),
    voucher_type: z.string().describe('Exact voucher type name (see list_voucher_types)'),
    voucher_number: z.string().optional().describe('Required for manually numbered voucher types; ignored by auto-numbered ones'),
    reference: z.string().optional().describe('Supplier invoice no. / reference'),
    reference_date: z.string().optional(),
    narration: z.string().optional(),
    party_ledger: z.string().optional().describe('Party ledger (also marks that ledger entry as party)'),
    ledger_entries: z.array(ledgerEntry).optional().describe('Accounting lines'),
    inventory_entries: z.array(inventoryEntry).optional().describe('Stock item lines (makes it an item invoice)'),
    stock_out: z.array(stockLine).optional().describe('Stock Journal: source / consumption lines'),
    stock_in: z.array(stockLine).optional().describe('Stock Journal: destination / production lines'),
    is_optional: z.boolean().optional().describe('Create as an optional (memo) voucher'),
    extra_xml: z.string().optional().describe('Advanced: raw Tally XML tags appended inside <VOUCHER>'),
    dry_run: dryRun,
  },
  async (a) => {
    const v = { ...a, ledger_entries: a.ledger_entries || [] };
    if (v.inventory_entries?.some((e) => !e.direction)) v.base_type = await T.voucherBaseType(a.company, a.voucher_type);
    const xml = T.buildNewVoucherXml(v);
    if (a.dry_run) return { dry_run: true, xml: T.importEnvelope('Vouchers', a.company, xml) };
    const result = T.explain(await T.importData('Vouchers', a.company, xml));
    if (!result.created) return { success: false, result };
    const created = await T.findVoucher(a.company, { master_id: result.last_voucher_id }).then((x) => x.summary).catch(() => undefined);
    return { success: true, master_id: result.last_voucher_id, voucher: created, result };
  }
);

writeTool(
  'alter_voucher',
  'Modify an existing voucher. Identify it with master_id (preferred). Only the fields given in `changes` are modified; ' +
    'everything else (GST details, bank details, addresses...) is sent back unchanged. ' +
    'changes.ledger_entries REPLACES all ledger lines (for item invoices: the party/tax lines); changes.inventory_entries REPLACES all item lines; ' +
    'changes.stock_in / stock_out REPLACE the Stock Journal lines. Totals must still balance. ' +
    'An existing single bill reference on a ledger is kept automatically if you omit bill_allocations for it.',
  {
    company,
    ...voucherRef,
    changes: z.object({
      date: z.string().optional().describe('New date (YYYY-MM-DD)'),
      voucher_number: z.string().optional().describe('New number (only for manually numbered voucher types)'),
      reference: z.string().optional(),
      reference_date: z.string().optional(),
      narration: z.string().optional(),
      party_ledger: z.string().optional(),
      ledger_entries: z.array(ledgerEntry).optional(),
      inventory_entries: z.array(inventoryEntry).optional(),
      stock_in: z.array(stockLine).optional(),
      stock_out: z.array(stockLine).optional(),
      set_fields: z.record(z.string(), z.string()).optional().describe('Advanced: set other top-level voucher XML tags, e.g. {"BASICSHIPPEDBY": "Truck"}'),
    }),
    dry_run: dryRun,
  },
  async (a) => {
    const r = await T.alterVoucher(a.company, refOf(a), a.changes, { dryRun: a.dry_run });
    return r.dry_run ? r : { success: r.result.altered > 0 && !r.warning, ...r };
  }
);

writeTool(
  'delete_voucher',
  'Permanently delete a voucher from Tally (a backup is taken first). Identify it with master_id (preferred). Requires confirm: true. ' +
    'Show the user the voucher (get_voucher) and get their approval before calling this.',
  { company, ...voucherRef, confirm: z.literal(true).describe('Must be true'), dry_run: dryRun },
  async (a) => {
    const r = await T.deleteVoucher(a.company, refOf(a), { dryRun: a.dry_run });
    return r.dry_run ? r : { success: r.result.deleted > 0, ...r };
  }
);

// ---------------------------------------------------------------- master writes

const ledgerFields = {
  aliases,
  group: z.string().optional().describe('Parent group, e.g. "Sundry Debtors", "Indirect Expenses"'),
  opening_balance: z.number().nonnegative().optional(),
  opening_type: z.enum(['Dr', 'Cr']).optional().describe('Default Dr'),
  maintain_bill_wise: z.boolean().optional(),
  credit_days: z.number().int().optional(),
  mailing_name: z.string().optional(),
  address: z.array(z.string()).optional().describe('Address lines (replaces existing lines)'),
  state: z.string().optional(),
  country: z.string().optional(),
  pincode: z.string().optional(),
  gstin: z.string().optional(),
  gst_registration_type: z.enum(['Regular', 'Composition', 'Unregistered/Consumer', 'Unknown']).optional(),
  place_of_supply: z.string().optional().describe('Defaults to state'),
  pan: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  mobile: z.string().optional(),
  contact_person: z.string().optional(),
  extra_xml: z.string().optional().describe('Advanced: raw XML tags appended inside <LEDGER>'),
};

const stockFields = {
  aliases,
  group: z.string().optional().describe('Stock group (default Primary)'),
  category: z.string().optional().describe('Stock category'),
  unit: z.string().optional().describe('Base unit symbol; must exist (see create_master type unit)'),
  description: z.string().optional(),
  opening_quantity: z.number().nonnegative().optional(),
  opening_rate: z.number().nonnegative().optional(),
  opening_value: z.number().nonnegative().optional().describe('Defaults to quantity x rate'),
  opening_godown: z.string().optional().describe('Godown holding the opening stock (default Main Location)'),
  gst_rate: z.number().min(0).max(100).optional().describe('Total GST % (IGST); CGST/SGST are set to half each'),
  cess_rate: z.number().min(0).optional(),
  taxability: z.enum(['Taxable', 'Exempt', 'Nil Rated']).optional(),
  hsn_code: z.string().optional(),
  hsn_description: z.string().optional(),
  extra_xml: z.string().optional().describe('Advanced: raw XML tags appended inside <STOCKITEM>'),
};

// Opening balances drive every valuation and balance report, so changing them needs the user's explicit OK.
const confirmOpening = z
  .boolean()
  .optional()
  .describe('Set true ONLY after the user has seen the current vs new opening figures and explicitly approved the change');

function openingGate(type, keys) {
  return async (a) => {
    const asked = keys.filter((k) => a[k] !== undefined);
    if (!asked.length || a.confirm_opening_change === true) return undefined;
    const current = await M.getMaster(a.company, type, a.name);
    const pick = (o) => Object.fromEntries(keys.map((k) => [k, o[k]]).filter(([, v]) => v !== undefined));
    return {
      needs_confirmation: true,
      written: false,
      message:
        `Changing the OPENING ${type === 'ledger' ? 'BALANCE' : 'STOCK'} of "${a.name}" affects all stock/balance reports. ` +
        'Nothing has been changed. Show the user the current and new values below and ask them to confirm; ' +
        'only if they explicitly agree, call this tool again with the same arguments plus confirm_opening_change: true.',
      current_opening: pick(current),
      requested_opening: pick(a),
      ...(current.opening_by_godown ? { current_opening_by_godown: current.opening_by_godown } : {}),
    };
  };
}

writeTool('create_ledger', 'Create a ledger (party, bank, expense, income, tax...).', { company, name: z.string(), ...ledgerFields, group: z.string().describe('Parent group'), dry_run: dryRun }, (a) =>
  M.createMaster(a.company, 'ledger', strip(a), { dryRun: a.dry_run })
);

writeTool(
  'alter_ledger',
  'Modify a ledger: rename (new_name), group, opening balance, bill-wise, address, state, pincode, GSTIN, PAN, contacts. Only given fields change. ' +
    'Opening balance changes are two-step: the first call only returns current vs new values for the user to approve.',
  { company, name: z.string().describe('Current ledger name'), new_name: z.string().optional(), ...ledgerFields, confirm_opening_change: confirmOpening, dry_run: dryRun },
  (a) => M.alterMaster(a.company, 'ledger', a.name, strip(a), { dryRun: a.dry_run }),
  openingGate('ledger', ['opening_balance', 'opening_type'])
);

writeTool('create_stock_item', 'Create a stock item with unit, group, opening stock, GST rate and HSN.', { company, name: z.string(), ...stockFields, dry_run: dryRun }, (a) =>
  M.createMaster(a.company, 'stock_item', strip(a), { dryRun: a.dry_run })
);

writeTool(
  'alter_stock_item',
  'Modify a stock item: rename (new_name), group, unit, opening stock, GST rate, HSN, description. Only given fields change. ' +
    'Opening stock changes are two-step: the first call only returns current vs new opening figures; ask the user, then repeat with confirm_opening_change: true.',
  { company, name: z.string().describe('Current item name'), new_name: z.string().optional(), ...stockFields, confirm_opening_change: confirmOpening, dry_run: dryRun },
  (a) => M.alterMaster(a.company, 'stock_item', a.name, strip(a), { dryRun: a.dry_run }),
  openingGate('stock_item', ['opening_quantity', 'opening_rate', 'opening_value', 'opening_godown'])
);

const otherType = z.enum(['group', 'stock_group', 'godown', 'unit', 'cost_centre']);
const otherFields = {
  aliases,
  parent: z.string().optional().describe('Parent group / stock group / godown / cost centre ("Primary" for top level)'),
  category: z.string().optional().describe('cost_centre only: cost category (default Primary Cost Category)'),
  formal_name: z.string().optional().describe('unit only: formal name, e.g. "Kilograms"'),
  decimal_places: z.number().int().min(0).max(4).optional().describe('unit only'),
  extra_xml: z.string().optional(),
};

writeTool(
  'create_master',
  'Create an account group, stock group, godown, unit (name = symbol, e.g. "KG") or cost centre.',
  { company, type: otherType, name: z.string(), ...otherFields, dry_run: dryRun },
  (a) => M.createMaster(a.company, a.type, strip(a), { dryRun: a.dry_run })
);

writeTool(
  'alter_master',
  'Modify / rename an account group, stock group, godown, unit or cost centre. Only given fields change.',
  { company, type: otherType, name: z.string().describe('Current name'), new_name: z.string().optional(), ...otherFields, dry_run: dryRun },
  (a) => M.alterMaster(a.company, a.type, a.name, strip(a), { dryRun: a.dry_run })
);

writeTool(
  'delete_master',
  'Permanently delete a ledger, group, stock item, stock group, godown, unit or cost centre (a backup is taken first). ' +
    'Tally refuses if it is still used by vouchers or other masters. Requires confirm: true; get the user\'s approval first.',
  { company, type: masterType, name: z.string(), confirm: z.literal(true).describe('Must be true'), dry_run: dryRun },
  (a) => M.deleteMaster(a.company, a.type, a.name, { dryRun: a.dry_run })
);

writeTool(
  'import_raw_xml',
  'Advanced escape hatch: import raw Tally XML objects (the content that goes inside <TALLYMESSAGE>), e.g. a <VOUCHER> or <LEDGER> ' +
    'with ACTION="Create"/"Alter"/"Delete". Prefer the specific tools.',
  {
    company,
    report: z.enum(['Vouchers', 'All Masters']).describe('Vouchers for <VOUCHER>, All Masters for masters'),
    xml: z.string().describe('XML objects to place inside <TALLYMESSAGE>'),
    dry_run: dryRun,
  },
  async (a) => {
    if (a.dry_run) return { dry_run: true, xml: T.importEnvelope(a.report, a.company, a.xml) };
    return T.explain(await T.importData(a.report, a.company, a.xml));
  }
);

/** Tool arguments minus the control fields, i.e. just the master's values. */
function strip(a) {
  const { company: _c, dry_run: _d, confirm: _f, type: _t, confirm_opening_change: _o, ...fields } = a;
  return fields;
}

if (T.config.readOnly) console.error('[tally-write-mcp] TALLY_READONLY is set: write tools will refuse to run.');

await server.connect(new StdioServerTransport());
console.error(`[tally-write-mcp] ready, Tally at ${T.config.host}:${T.config.port}`);
