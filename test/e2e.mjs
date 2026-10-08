// End-to-end test through the MCP protocol against the active company. Uses "MCP TEST" objects
// dated on the 1st (works in Educational mode) and removes everything it creates.
//   TALLY_PORT=9001 TALLY_BACKUP_DIR=<temp folder> node test/e2e.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'e2e', version: '1' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['src/index.js'], env: { ...process.env } }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
  const text = r.content[0].text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};
let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : ''}`);
};
const D = '2025-10-01';
const vouchers = [];
const masters = []; // deleted in this order

try {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check('tools listed', tools.length === 21, tools.length);
  const st = await call('tally_status');
  check('status', /Running/.test(st.status), st.companies);

  // ---- account masters
  let r = await call('create_master', { type: 'group', name: 'MCP TEST GROUP', parent: 'Sundry Debtors' });
  masters.push(['group', 'MCP TEST GROUP']);
  check('create group (+auto backup)', r.success && r.backup?.[0]?.files > 0, r.backup);
  r = await call('create_ledger', { name: 'MCP TEST PARTY', group: 'MCP TEST GROUP', address: ['Shop 1', 'Main Bazar'], state: 'Delhi', pincode: '110041', gstin: '07AAAAA0000A1Z5', pan: 'AAAAA0000A', maintain_bill_wise: true, opening_balance: 100, opening_type: 'Dr' });
  masters.unshift(['ledger', 'MCP TEST PARTY']);
  check('create ledger with GST/address', r.success && r.saved.gstin === '07AAAAA0000A1Z5' && r.saved.address.length === 2, r.saved);
  r = await call('alter_ledger', { name: 'MCP TEST PARTY', new_name: 'MCP TEST PARTY 2', pincode: '110042', email: 'a@b.com' });
  if (r.success) masters[0] = ['ledger', 'MCP TEST PARTY 2'];
  check('alter ledger (rename, pincode, email) keeps address/GSTIN', r.success && r.after.name === 'MCP TEST PARTY 2' && r.after.pincode === '110042' && r.after.address.length === 2 && r.after.gstin, r.after);
  r = await call('alter_ledger', { name: 'MCP TEST PARTY 2', opening_balance: 300 });
  check('ledger opening change asks first (nothing written)', r.needs_confirmation && !r.backup, r.current_opening);
  check('ledger opening unchanged', (await call('get_master', { type: 'ledger', name: 'MCP TEST PARTY 2' })).opening_balance === 100);
  r = await call('alter_ledger', { name: 'MCP TEST PARTY 2', opening_balance: 300, confirm_opening_change: true });
  check('ledger opening change after confirmation', r.success && r.after.opening_balance === 300, r.after?.opening_balance);

  // ---- inventory masters
  r = await call('create_master', { type: 'unit', name: 'MCPU', formal_name: 'MCP Unit', decimal_places: 2 });
  masters.push(['unit', 'MCPU']);
  check('create unit', r.success, r.saved);
  r = await call('create_master', { type: 'stock_group', name: 'MCP TEST SG', parent: 'Primary' });
  masters.splice(masters.length - 1, 0, ['stock_group', 'MCP TEST SG']);
  check('create stock group', r.success);
  r = await call('create_master', { type: 'godown', name: 'MCP TEST GODOWN', parent: 'Primary' });
  masters.unshift(['godown', 'MCP TEST GODOWN']);
  check('create godown', r.success);
  r = await call('alter_master', { type: 'godown', name: 'MCP TEST GODOWN', new_name: 'MCP TEST GODOWN 2' });
  if (r.success) masters[0] = ['godown', 'MCP TEST GODOWN 2'];
  check('rename godown', r.success && r.after.name === 'MCP TEST GODOWN 2');
  r = await call('create_stock_item', { name: 'MCP TEST ITEM', group: 'MCP TEST SG', unit: 'MCPU', opening_quantity: 10, opening_rate: 5, gst_rate: 5, hsn_code: '17011490', hsn_description: 'Test' });
  masters.unshift(['stock_item', 'MCP TEST ITEM']);
  check('create stock item (opening, GST, HSN)', r.success && r.saved.opening_quantity === 10 && r.saved.gst_rate === 5 && r.saved.hsn_code === '17011490', r.saved);
  r = await call('alter_stock_item', { name: 'MCP TEST ITEM', new_name: 'MCP TEST ITEM 2', gst_rate: 12, hsn_code: '21069099' });
  if (r.success) masters[0] = ['stock_item', 'MCP TEST ITEM 2'];
  check('alter stock item (rename, GST 12, HSN) keeps opening', r.success && r.after.gst_rate === 12 && r.after.hsn_code === '21069099' && r.after.opening_quantity === 10, r.after);
  r = await call('alter_stock_item', { name: 'MCP TEST ITEM 2', opening_quantity: 20 });
  check('opening stock change asks first (nothing written, no backup)', r.needs_confirmation && !r.backup && r.current_opening.opening_quantity === 10, r);
  check('opening stock unchanged before confirmation', (await call('get_master', { type: 'stock_item', name: 'MCP TEST ITEM 2' })).opening_quantity === 10);
  r = await call('alter_stock_item', { name: 'MCP TEST ITEM 2', opening_quantity: 20, confirm_opening_change: true });
  check('opening stock 10 -> 20 after confirmation', r.success && r.after.opening_quantity === 20 && r.after.opening_value === 100, r.after);

  // ---- vouchers
  r = await call('create_voucher', { date: D, voucher_type: 'Journal', narration: 'MCP TEST journal', ledger_entries: [{ ledger: 'MISC', type: 'Dr', amount: 1 }, { ledger: 'ROUND OFF', type: 'Cr', amount: 1 }] });
  if (r.success) vouchers.push(r.master_id);
  check('create journal', r.success, r.result);
  r = await call('alter_voucher', { master_id: r.master_id, changes: { narration: 'MCP TEST journal altered', ledger_entries: [{ ledger: 'MISC', type: 'Dr', amount: 3 }, { ledger: 'ROUND OFF', type: 'Cr', amount: 3 }] } });
  check('alter journal', r.success && r.after.amount === 3, r.after);

  r = await call('create_voucher', {
    date: D, voucher_type: 'SALES GST-RD', voucher_number: 'MCPTEST3', narration: 'MCP TEST invoice', party_ledger: 'MCP TEST PARTY 2',
    inventory_entries: [{ item: 'MCP TEST ITEM 2', quantity: 2, unit: 'MCPU', rate: 10, ledger: 'SALES RD', godown: 'MCP TEST GODOWN 2' }],
    ledger_entries: [{ ledger: 'MCP TEST PARTY 2', type: 'Dr', amount: 21.2, bill_allocations: [{ name: 'MCPTEST3' }] }, { ledger: 'CGST', type: 'Cr', amount: 0.6 }, { ledger: 'SGST', type: 'Cr', amount: 0.6 }],
  });
  if (r.success) vouchers.push(r.master_id);
  check('create GST item invoice with bill ref', r.success && r.voucher.amount === 21.2, r.voucher || r.result);
  r = await call('alter_voucher', { master_id: r.master_id, changes: {
    inventory_entries: [{ item: 'MCP TEST ITEM 2', quantity: 3, unit: 'MCPU', rate: 10, ledger: 'SALES RD', godown: 'MCP TEST GODOWN 2' }],
    ledger_entries: [{ ledger: 'MCP TEST PARTY 2', type: 'Dr', amount: 31.8 }, { ledger: 'CGST', type: 'Cr', amount: 0.9 }, { ledger: 'SGST', type: 'Cr', amount: 0.9 }] } });
  check('alter invoice qty (bill ref carried over)', r.success && r.after.amount === 31.8 && r.after.ledger_entries[0].bill_allocations?.[0]?.name === 'MCPTEST3', r.after);

  r = await call('create_voucher', { date: D, voucher_type: 'Stock Journal', narration: 'MCP TEST transfer',
    stock_out: [{ item: 'MCP TEST ITEM 2', quantity: 5, unit: 'MCPU', rate: 5, godown: 'Main Location' }],
    stock_in: [{ item: 'MCP TEST ITEM 2', quantity: 5, unit: 'MCPU', rate: 5, godown: 'MCP TEST GODOWN 2' }] });
  if (r.success) vouchers.push(r.master_id);
  check('create stock journal (godown transfer)', r.success && r.voucher.stock_in?.length === 1, r.voucher);
  r = await call('alter_voucher', { master_id: r.master_id, changes: {
    stock_out: [{ item: 'MCP TEST ITEM 2', quantity: 6, unit: 'MCPU', rate: 5, godown: 'Main Location' }],
    stock_in: [{ item: 'MCP TEST ITEM 2', quantity: 6, unit: 'MCPU', rate: 5, godown: 'MCP TEST GODOWN 2' }] } });
  check('alter stock journal', r.success && r.after.stock_in[0].quantity.startsWith('6'), r.after);

  const items = await call('list_stock_items', { search: 'MCP TEST' });
  check('closing stock = 20 opening - 3 sold', items[0]?.closing_qty?.startsWith('17'), items);
  const lv = await call('list_vouchers', { from: D, to: D, item: 'MCP TEST ITEM 2' });
  check('list_vouchers by item', lv.total === 2, lv.vouchers.map((v) => v.voucher_type));
  const bk = await call('list_backups');
  check('backups recorded', bk.backups.length > 0, bk.backups.length);
} catch (e) {
  failures++;
  console.log('STOPPED:', e.message);
} finally {
  for (const id of vouchers) {
    const r = await call('delete_voucher', { master_id: id, confirm: true }).catch((e) => ({ error: e.message }));
    check(`delete voucher ${id}`, r.success, r.error);
  }
  for (const [type, name] of masters) {
    const r = await call('delete_master', { type, name, confirm: true }).catch((e) => ({ error: e.message }));
    check(`delete ${type} ${name}`, r.success, r.error || r.result);
  }
  const st = await call('tally_status').catch((e) => ({ status: e.message }));
  check('Tally still running', /Running/.test(st.status), st.status);
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
  await client.close();
}
