/*
 * Backup seguro de picks.db usando la API nativa de SQLite (consistente
 * incluso con el servidor corriendo). Nunca sobrescribe; nunca toca la
 * base original; no incluye secretos (la DB no los contiene).
 *
 * Uso (desde server/):
 *   node backtest/backup-db.js          → crea backups/picks-<timestamp>.db
 *   node backtest/backup-db.js --list   → lista backups existentes
 *
 * Restauración MANUAL (nunca automática):
 *   1. Detén el servidor.
 *   2. cp backups/picks-<timestamp>.db picks.db
 *   3. node backtest/audit-db.js para verificar integridad.
 */
import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, statSync, readdirSync } from "fs";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const DB_PATH    = join(__dirname, "..", "picks.db");
const BACKUP_DIR = join(__dirname, "..", "backups");

if (process.argv.includes("--list")) {
  if (!existsSync(BACKUP_DIR)) { console.log("Sin backups aún."); process.exit(0); }
  const files = readdirSync(BACKUP_DIR).filter(f => f.endsWith(".db")).sort();
  if (!files.length) { console.log("Sin backups aún."); process.exit(0); }
  console.log(`Backups en ${BACKUP_DIR}:`);
  for (const f of files) {
    const s = statSync(join(BACKUP_DIR, f));
    console.log(`  ${f}  ${(s.size / 1024).toFixed(1)} KB  ${s.mtime.toISOString()}`);
  }
  process.exit(0);
}

mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dest  = join(BACKUP_DIR, `picks-${stamp}.db`);

if (existsSync(dest)) {
  console.error(`✗ ${dest} ya existe — no se sobrescribe. Reintenta en un segundo.`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
await db.backup(dest);
db.close();

if (!existsSync(dest)) {
  console.error("✗ El backup no se creó.");
  process.exit(1);
}
const size = statSync(dest).size;
if (size === 0) {
  console.error("✗ El backup quedó vacío — no confíes en él.");
  process.exit(1);
}
console.log(`✓ Backup creado: ${dest} (${(size / 1024).toFixed(1)} KB)`);
console.log(`  Original intacto: ${DB_PATH} (${(statSync(DB_PATH).size / 1024).toFixed(1)} KB)`);
