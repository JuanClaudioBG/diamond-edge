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
    fecha_creacion TEXT NOT NULL DEFAULT (datetime('now')),
    player         TEXT DEFAULT NULL,
    market         TEXT DEFAULT NULL,
    side           TEXT DEFAULT NULL CHECK (side IS NULL OR side IN ('Over', 'Under')),
    point          REAL DEFAULT NULL,
    props_json     TEXT DEFAULT NULL
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

/* Migraciones retrocompatibles (ALTER falla silenciosamente si ya existe) */
try { db.exec("ALTER TABLE picks ADD COLUMN analysis_id INTEGER"); } catch { /* ya existe */ }
try { db.exec("ALTER TABLE picks ADD COLUMN player TEXT DEFAULT NULL"); } catch { /* ya existe */ }
try { db.exec("ALTER TABLE picks ADD COLUMN market TEXT DEFAULT NULL"); } catch { /* ya existe */ }
try { db.exec("ALTER TABLE picks ADD COLUMN side TEXT DEFAULT NULL CHECK (side IS NULL OR side IN ('Over', 'Under'))"); } catch { /* ya existe */ }
try { db.exec("ALTER TABLE picks ADD COLUMN point REAL DEFAULT NULL"); } catch { /* ya existe */ }
try { db.exec("ALTER TABLE picks ADD COLUMN props_json TEXT DEFAULT NULL"); } catch { /* ya existe */ }
try { db.exec("ALTER TABLE analysis_log ADD COLUMN odds_fetched_at TEXT"); } catch { /* ya existe */ }

export const getAllPicks = () =>
  db.prepare("SELECT * FROM picks ORDER BY fecha_creacion DESC").all();

export const insertPick = ({
  fecha,
  partido,
  tipo,
  pick,
  valor,
  riesgo,
  analysis_id = null,
  player = null,
  market = null,
  side = null,
  point = null,
  props_json = null,
}) =>
  db.prepare(`
    INSERT INTO picks (
      fecha, partido, tipo, pick, valor, riesgo, analysis_id,
      player, market, side, point, props_json
    ) VALUES (
      @fecha, @partido, @tipo, @pick, @valor, @riesgo, @analysis_id,
      @player, @market, @side, @point, @props_json
    )
  `).run({
    fecha,
    partido,
    tipo,
    pick,
    valor,
    riesgo,
    analysis_id,
    player,
    market,
    side,
    point,
    props_json,
  });

export const updateResultado = (id, resultado) =>
  db.prepare("UPDATE picks SET resultado = ? WHERE id = ?").run(resultado, id);

export const getUnsettledOfficialProps = () =>
  db.prepare(`
    SELECT
      p.id, p.analysis_id, p.player, p.market, p.side, p.point, p.props_json,
      p.fecha, p.partido, p.pick,
      a.game_pk, a.game_date
    FROM picks p
    JOIN analysis_log a ON a.id = p.analysis_id
    WHERE p.resultado IS NULL
      AND lower(trim(p.tipo)) = 'prop oficial'
      AND p.player IS NOT NULL
      AND p.market IS NOT NULL
      AND p.side IS NOT NULL
      AND p.point IS NOT NULL
      AND p.props_json IS NOT NULL
      AND a.game_pk IS NOT NULL
    ORDER BY a.game_pk, p.id
  `).all();

export const settleOfficialProp = (id, resultado) => {
  if (!["ganó", "perdió", "push", "void"].includes(resultado)) {
    throw new TypeError(`Resultado de prop inválido: ${resultado}`);
  }
  return db.prepare(`
    UPDATE picks
    SET resultado = @resultado
    WHERE id = @id
      AND resultado IS NULL
      AND lower(trim(tipo)) = 'prop oficial'
  `).run({ id, resultado });
};

export const insertAnalysisLog = (row) =>
  db.prepare(`
    INSERT INTO analysis_log (
      game_pk, game_date, home_team, away_team, logic_version, model, retro,
      data_quality, sections_json, odds_json, odds_fetched_at, market_prob_home, market_prob_away,
      llm_prob_home, predicted_winner, confianza, calificacion,
      total_estimado, total_reco, ev_pct, context_json, output_json
    ) VALUES (
      @game_pk, @game_date, @home_team, @away_team, @logic_version, @model, @retro,
      @data_quality, @sections_json, @odds_json, @odds_fetched_at, @market_prob_home, @market_prob_away,
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
