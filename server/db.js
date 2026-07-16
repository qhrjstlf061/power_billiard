"use strict";

/* =========================================================
   B3: 전적 DB — Node 내장 SQLite (node:sqlite, 별도 설치 불필요)
   ⚠️ Render 무료 티어는 디스크가 휘발성 → 재배포/재시작 시 초기화됨
   (학교 프로젝트 수준에서 허용. 영구 보존이 필요하면 유료 디스크 or 외부 DB)
   ========================================================= */
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "billiard.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    uid TEXT PRIMARY KEY,
    nick TEXT NOT NULL,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    winner_uid TEXT NOT NULL,
    loser_uid TEXT NOT NULL,
    winner_nick TEXT NOT NULL,
    loser_nick TEXT NOT NULL,
    winner_score INTEGER NOT NULL,
    loser_score INTEGER NOT NULL,
    forfeit INTEGER NOT NULL DEFAULT 0
  );
`);

const upsertStmt = db.prepare(`
  INSERT INTO players (uid, nick, created_at, last_seen) VALUES (?, ?, ?, ?)
  ON CONFLICT(uid) DO UPDATE SET nick = excluded.nick, last_seen = excluded.last_seen
`);
const winStmt = db.prepare("UPDATE players SET wins = wins + 1 WHERE uid = ?");
const loseStmt = db.prepare("UPDATE players SET losses = losses + 1 WHERE uid = ?");
const matchStmt = db.prepare(`
  INSERT INTO matches (at, winner_uid, loser_uid, winner_nick, loser_nick, winner_score, loser_score, forfeit)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

function upsertPlayer(uid, nick) {
  const now = Date.now();
  upsertStmt.run(uid, nick, now, now);
}

function recordMatch(winner, loser, forfeit) {
  // 시드가 없던 플레이어도 기록되도록 먼저 보장
  upsertPlayer(winner.uid, winner.nick);
  upsertPlayer(loser.uid, loser.nick);
  matchStmt.run(Date.now(), winner.uid, loser.uid, winner.nick, loser.nick,
    winner.score | 0, loser.score | 0, forfeit ? 1 : 0);
  winStmt.run(winner.uid);
  loseStmt.run(loser.uid);
}

function getRanking(limit = 10) {
  return db.prepare(`
    SELECT nick, wins, losses FROM players
    WHERE wins + losses > 0
    ORDER BY wins DESC, losses ASC, last_seen DESC
    LIMIT ?
  `).all(limit);
}

function getPlayer(uid) {
  const p = db.prepare("SELECT nick, wins, losses FROM players WHERE uid = ?").get(uid);
  if (!p) return null;
  const recent = db.prepare(`
    SELECT at, winner_nick, loser_nick, winner_score, loser_score, forfeit,
           (winner_uid = ?) AS won
    FROM matches WHERE winner_uid = ? OR loser_uid = ?
    ORDER BY at DESC LIMIT 5
  `).all(uid, uid, uid);
  return { nick: p.nick, wins: p.wins, losses: p.losses, recent };
}

module.exports = { upsertPlayer, recordMatch, getRanking, getPlayer };
