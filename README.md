# Tally Prime MCP Server (Read & Write)

An [MCP](https://modelcontextprotocol.io) server that lets Claude **read, add, modify and delete** data in TallyPrime over Tally's XML port.
It covers vouchers, item invoices, stock journals, ledgers, stock items, groups, stock groups, godowns, units and cost centres.

**Before every change it backs up the company data folder** to `Desktop\Tally Backups`.
Changing an opening balance or opening stock always asks you first.

**[⬇ Download the latest release](https://github.com/gargcamanish-tech/tally-prime-mcp/releases/latest)** (`tally-prime-mcp-1.1.0.mcpb`, one-click install for Claude Desktop)

> ⚠️ This tool writes to your books of account. Test it on a copy of your company first, keep backups switched on,
> and review what Claude proposes before approving deletes or opening-balance changes. Provided as-is under the MIT License.

---

## 1. Set up TallyPrime

1. Open TallyPrime and load the company.
2. Press **F1 (Help) → Settings → Connectivity**.
   - **TallyPrime acts as** = `Server` (or `Both`)
   - Note the **Port** number (default is `9000`).
3. Keep Tally open whenever you want Claude to use it.

## 2. Install in Claude Desktop (easiest, nothing else needed)

1. Install the [Claude Desktop](https://claude.ai/download) app and sign in.
2. Download `tally-prime-mcp-1.1.0.mcpb` from the [Releases page](https://github.com/gargcamanish-tech/tally-prime-mcp/releases/latest).
3. Double-click it, then click **Install**.
4. In the extension's settings:

| Setting | Default | Meaning |
|---|---|---|
| Tally host | `localhost` | Host or IP of the PC running TallyPrime |
| Tally port | `9001` | **Change this to the port from step 1** (usually `9000`) |
| Read-only mode | off | Blocks every write tool |
| Backup before every change | on | Copies the company data folder before each create/alter/delete |
| Backup folder | `Desktop\Tally Backups` | Where backups go |
| Backups to keep per company | 30 | Older automatic backups are removed (0 = keep all; each is about the size of the company folder) |

5. Start a new chat and ask: **"Check Tally status"**.
   It should answer "TallyPrime Server is Running" and list your company.

## 3. Claude Code or another MCP client (optional)

Needs [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/gargcamanish-tech/tally-prime-mcp.git
cd tally-prime-mcp
npm install
```

**Claude Code** (change the path and port):

```bash
claude mcp add --scope user tally-write -e TALLY_PORT=9000 -- node "C:\path\to\tally-prime-mcp\src\index.js"
```

**Other clients**, add to their MCP config:

```json
"tally-write": {
  "command": "node",
  "args": ["C:\\path\\to\\tally-prime-mcp\\src\\index.js"],
  "env": { "TALLY_PORT": "9000" }
}
```

Environment variables: `TALLY_HOST`, `TALLY_PORT`, `TALLY_COMPANY`, `TALLY_READONLY=true`, `TALLY_AUTO_BACKUP=false`,
`TALLY_BACKUP_DIR`, `TALLY_BACKUP_KEEP`, `TALLY_TIMEOUT_MS` (default 180000).

---

## Tools (21)

| Area | Tools |
|---|---|
| Status & backups | `tally_status`, `backup_data`, `list_backups` |
| Read | `list_ledgers`, `list_stock_items`, `list_masters`, `get_master`, `list_voucher_types`, `list_vouchers`, `get_voucher` |
| Vouchers | `create_voucher` (accounting, item invoice, stock journal), `alter_voucher`, `delete_voucher` |
| Ledgers | `create_ledger`, `alter_ledger` |
| Stock items | `create_stock_item`, `alter_stock_item` |
| Other masters | `create_master`, `alter_master` (group, stock group, godown, unit, cost centre), `delete_master` (any type) |
| Advanced | `import_raw_xml` |

### Safety rules built in

- **Backup first:** each write copies the company folder (path read from Tally) to
  `Desktop\Tally Backups\<company> <date time> <tool>` and checks every file was copied. If the backup fails, the change is not made.
- **Opening balance / opening stock:** changing a ledger's opening balance, or a stock item's opening quantity, rate, value or godown, takes two steps.
  The first call writes nothing and returns the current vs new figures; Claude must show you and get your yes. Only then is it repeated with `confirm_opening_change: true`.
- **Deletes** need `confirm: true`. Every write tool also supports `dry_run: true` to preview the XML.
- **Alter** changes only the fields you name; everything else is kept: GST and bank details, addresses, bill references.
- **Read-only mode** (`TALLY_READONLY=true`) blocks all writes.

### Restoring a backup

Close TallyPrime, then copy the numbered folder (e.g. `021047`) from inside the backup over the company's data folder
(`tally_status` shows the path). Reopen Tally.

### Examples you can ask Claude

- "Record a payment of ₹12,500 from HDFC Bank to Rent on 1 Oct 2025, narration 'October rent'."
- "Make a sales invoice to S P Enterprises: 1200 KG SUGAR-17011490-5% @ 42.05, SALES RD, CGST and SGST 2.5% each."
- "Change the quantity in invoice A908 to 1000 KG and recompute the taxes."
- "Transfer 50 KG sugar from Main Location to Godown 2 on 1 Oct 2025."
- "Change the GST rate of SUGAR-17011490-5% to 12% and the HSN to 17019990."
- "Create godown 'Shop' and stock group 'Sweeteners'; move the sugar item into it."

---

## Good to know

- **Educational (unlicensed) TallyPrime** only accepts entry dates on the 1st, 2nd and 31st.
  Other dates fail with "Voucher date is missing".
- **GST amounts are not calculated by Tally on import**; pass the CGST/SGST/IGST ledger lines (Claude can compute them).
- **Altering or deleting a voucher** needs a voucher number that is unique on that date.
- `list_vouchers` takes about 5 s per month of data; financial years are assumed to start in April.

## Verified on TallyPrime 6.1

Tested on a live GST trading company; all test objects were removed afterwards.
`test/e2e.mjs` runs 36 checks through the MCP protocol, and all pass:

- ledger create, rename and partial alter (address and GSTIN kept);
- opening-balance confirmation;
- units, stock groups, godowns and groups;
- stock item create, rename, GST/HSN change and opening-stock confirmation (10 → 20);
- journal, GST item invoice with bill reference, and stock journal godown transfer: each created, altered and deleted;
- closing stock correct;
- an automatic backup before every write;
- every master type deleted, with Tally still running.

### Things learned about this Tally version

- A voucher is identified by **date + voucher number + type**. Matching by GUID/REMOTEID silently creates a duplicate,
  so alter/delete refuse vouchers with no number, or with a number repeated on the same date.
- Alter must send the **whole** voucher, so the server fetches it, changes only what was asked, and sends it back.
- Names use `LANGUAGENAME.LIST`. The older top-level `NAME.LIST` rename, followed by a delete, crashed Tally
  (Memory Access Violation). The current method was retested several times without a crash.
- Opening stock lives in the item's godown batch allocation; the item-level figures alone are ignored on alter.

## Development

```bash
npm install
TALLY_PORT=9000 TALLY_BACKUP_DIR=<temp folder> npm run e2e   # creates, alters and deletes test entries
npx @anthropic-ai/mcpb pack . tally-prime-mcp.mcpb
```

The e2e test expects ledgers named `MISC`, `ROUND OFF`, `SALES RD`, `CGST`, `SGST` and a voucher type `SALES GST-RD`
in the active company; adjust `test/e2e.mjs` for your own masters.

## License

[MIT](LICENSE) © 2026 Manish Bansal
