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

db.exec(`
  CREATE TABLE IF NOT EXISTS analysis_log (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    game_pk           INTEGER,
    game_date         TEXT,
    home_team         TEXT,
    away_team         TEXT,
    logic_version     TEXT,
    model             TEXT,
    retro             INTEGER DEFAULT 0,
    data_quality      REAL,
    sections_json     TEXT,
    odds_json         TEXT,
    market_prob_home  REAL,
    market_prob_away  REAL,
    llm_prob_home     REAL,
    predicted_winner  TEXT,
    confianza         TEXT,
    calificacion      INTEGER,
    total_estimado    TEXT,
    total_reco        TEXT,
    ev_pct            REAL,
    context_json      TEXT,
    output_json       TEXT,
    resultado         TEXT DEFAULT NULL
  )
`);

/* Migración retrocompatible: enlaza cada pick con su análisis de origen */
try { db.exec("ALTER TABLE picks ADD COLUMN analysis_id INTEGER"); } catch { /* ya existe */ }

export const getAllPicks = () =>
  db.prepare("SELECT * FROM picks ORDER BY fecha_creacion DESC").all();

export const insertPick = ({ fecha, partido, tipo, pick, valor, riesgo, analysis_id = null }) =>
  db.prepare(`
    INSERT INTO picks (fecha, partido, tipo, pick, valor, riesgo, analysis_id)
    VALUES (@fecha, @partido, @tipo, @pick, @valor, @riesgo, @analysis_id)
  `).run({ fecha, partido, tipo, pick, valor, riesgo, analysis_id });

export const updateResultado = (id, resultado) =>
  db.prepare("UPDATE picks SET resultado = ? WHERE id = ?").run(resultado, id);

export const insertAnalysisLog = (row) =>
  db.prepare(`
    INSERT INTO analysis_log (
      game_pk, game_date, home_team, away_team, logic_version, model, retro,
      data_quality, sections_json, odds_json, market_prob_home, market_prob_away,
      llm_prob_home, predicted_winner, confianza, calificacion,
      total_estimado, total_reco, ev_pct, context_json, output_json
    ) VALUES (
      @game_pk, @game_date, @home_team, @away_team, @logic_version, @model, @retro,
      @data_quality, @sections_json, @odds_json, @market_prob_home, @market_prob_away,
      @llm_prob_home, @predicted_winner, @confianza, @calificacion,
      @total_estimado, @total_reco, @ev_pct, @context_json, @output_json
    )
  `).run(row);

export const getUnsettledAnalyses = () =>
  db.prepare("SELECT id, game_pk, game_date FROM analysis_log WHERE resultado IS NULL AND game_pk IS NOT NULL").all();

export const settleAnalysis = (id, resultado) =>
  db.prepare("UPDATE analysis_log SET resultado = ? WHERE id = ?").run(resultado, id);

export const getSettledAnalyses = () =>
  db.prepare("SELECT * FROM analysis_log WHERE resultado IS NOT NULL").all();

export const getAllAnalyses = () =>
  db.prepare("SELECT * FROM analysis_log ORDER BY created_at").all();
