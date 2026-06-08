import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, "picks.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS picks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha          TEXT NOT NULL,
    partido        TEXT NOT NULL,
    tipo           TEXT NOT NULL,
    pick           TEXT NOT NULL,
    valor          TEXT,
    riesgo         TEXT,
    resultado      TEXT DEFAULT NULL,
    fecha_creacion TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export const getAllPicks = () =>
  db.prepare("SELECT * FROM picks ORDER BY fecha_creacion DESC").all();

export const insertPick = ({ fecha, partido, tipo, pick, valor, riesgo }) =>
  db.prepare(`
    INSERT INTO picks (fecha, partido, tipo, pick, valor, riesgo)
    VALUES (@fecha, @partido, @tipo, @pick, @valor, @riesgo)
  `).run({ fecha, partido, tipo, pick, valor, riesgo });

export const updateResultado = (id, resultado) =>
  db.prepare("UPDATE picks SET resultado = ? WHERE id = ?").run(resultado, id);
