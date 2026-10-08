// Copies the company's Tally data folder to a dated folder on the Desktop before every write.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exportCollection, config } from './tally.js';

export const backupConfig = {
  enabled: !/^(0|false|no)$/i.test(process.env.TALLY_AUTO_BACKUP || ''),
  dir: process.env.TALLY_BACKUP_DIR || path.join(os.homedir(), 'Desktop', 'Tally Backups'),
  // 0 = keep every backup
  keep: /^\d+$/.test(process.env.TALLY_BACKUP_KEEP || '') ? Number(process.env.TALLY_BACKUP_KEEP) : 30,
};

const safe = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function folderStats(dir) {
  let files = 0, bytes = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const s = folderStats(p);
      files += s.files; bytes += s.bytes;
    } else {
      files += 1; bytes += fs.statSync(p).size;
    }
  }
  return { files, bytes };
}

/** Data folders of the target company (or every loaded company when none is named). */
async function companyFolders(company) {
  const rows = await exportCollection({ type: 'Company', fields: ['Name', 'Destination'], company });
  const list = company ? rows.filter((r) => r.name === company) : rows;
  const target = list.length ? list : rows;
  if (!target.length) throw new Error('Tally reported no loaded company to back up.');
  return target.map((r) => ({ name: r.name, folder: r.destination }));
}

function prune(companyName) {
  if (!(backupConfig.keep > 0)) return [];
  const prefix = `${safe(companyName)} `;
  const old = fs
    .readdirSync(backupConfig.dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix) && fs.existsSync(path.join(backupConfig.dir, e.name, 'backup-info.json')))
    .map((e) => e.name)
    .sort()
    .slice(0, -backupConfig.keep);
  for (const name of old) fs.rmSync(path.join(backupConfig.dir, name), { recursive: true, force: true });
  return old;
}

/** Back up the company data folder(s). Throws if a copy is incomplete, so the write that follows is not attempted. */
export async function backupCompany(company, operation = 'manual') {
  const results = [];
  for (const { name, folder } of await companyFolders(company)) {
    if (!folder || !fs.existsSync(folder)) throw new Error(`Backup failed: data folder for "${name}" not found (${folder || 'unknown'}).`);
    const dest = path.join(backupConfig.dir, `${safe(name)} ${stamp()} ${safe(operation)}`, path.basename(folder));
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(folder, dest, { recursive: true });
    const src = folderStats(folder), copy = folderStats(dest);
    if (copy.files !== src.files || copy.bytes < src.bytes)
      throw new Error(`Backup of "${name}" is incomplete (${copy.files}/${src.files} files). Write cancelled.`);
    fs.writeFileSync(
      path.join(path.dirname(dest), 'backup-info.json'),
      JSON.stringify({ company: name, source: folder, operation, created: new Date().toISOString(), tally: `${config.host}:${config.port}`, ...src }, null, 2)
    );
    results.push({ company: name, folder: path.dirname(dest), files: src.files, mb: Math.round((src.bytes / 1048576) * 10) / 10, pruned: prune(name).length });
  }
  return results;
}

export function listBackups() {
  if (!fs.existsSync(backupConfig.dir)) return [];
  return fs
    .readdirSync(backupConfig.dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const info = path.join(backupConfig.dir, e.name, 'backup-info.json');
      return fs.existsSync(info) ? { folder: path.join(backupConfig.dir, e.name), ...JSON.parse(fs.readFileSync(info, 'utf8')) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.created.localeCompare(a.created));
}
