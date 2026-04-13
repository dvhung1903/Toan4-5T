import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const PLAYERS_KEY = 'math_players';      // { name -> {score, weekScore, lastReset, dailyAdd, dailyMul} }
const WEEKLY_KEY  = 'math_weekly_best';  // { name, score, week }
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function getWeekId() {
  // Week number since epoch (Monday-based)
  const now = Date.now();
  return Math.floor(now / WEEK_MS);
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

async function getPlayers() {
  return (await redis.get(PLAYERS_KEY)) || {};
}
async function savePlayers(players) {
  await redis.set(PLAYERS_KEY, players);
}

async function checkWeeklyReset(players) {
  const currentWeek = getWeekId();
  let changed = false;
  let prevBest = await redis.get(WEEKLY_KEY);

  // Check if any player needs weekly reset
  for (const name of Object.keys(players)) {
    const p = players[name];
    if (!p.week || p.week < currentWeek) {
      // Before resetting, check if this player was best of previous week
      if (!prevBest || (p.weekScore || 0) > (prevBest.score || 0)) {
        prevBest = { name, score: p.weekScore || 0, week: p.week || currentWeek - 1 };
        await redis.set(WEEKLY_KEY, prevBest);
      }
      p.weekScore = 0;
      p.week = currentWeek;
      changed = true;
    }
  }
  return { players, changed, prevBest };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── GET /api/math?action=leaderboard ──
  if (req.method === 'GET' && action === 'leaderboard') {
    let players = await getPlayers();
    const { players: p2, prevBest } = await checkWeeklyReset(players);
    const lb = Object.entries(p2)
      .map(([name, d]) => ({ name, score: d.weekScore || 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    return res.status(200).json({ ok: true, lb, prevBest });
  }

  // ── POST /api/math?action=register ──
  if (req.method === 'POST' && action === 'register') {
    const { name } = req.body;
    if (!name || name.length < 4 || name.length > 16)
      return res.status(400).json({ ok: false, error: 'Tên phải từ 4–16 ký tự' });

    let players = await getPlayers();
    const nameLower = name.toLowerCase();
    const existing = Object.keys(players).find(k => k.toLowerCase() === nameLower);
    if (existing)
      return res.status(400).json({ ok: false, error: 'Tên đã tồn tại, chọn tên khác' });

    const week = getWeekId();
    players[name] = { weekScore: 0, week, dailyAdd: {}, dailyMul: {} };
    await savePlayers(players);
    return res.status(200).json({ ok: true, name });
  }

  // ── POST /api/math?action=login ──
  if (req.method === 'POST' && action === 'login') {
    const { name } = req.body;
    let players = await getPlayers();
    const key = Object.keys(players).find(k => k.toLowerCase() === name.toLowerCase());
    if (!key) return res.status(404).json({ ok: false, error: 'Tên không tồn tại' });
    const { players: p2 } = await checkWeeklyReset(players);
    await savePlayers(p2);
    const p = p2[key];
    const today = getTodayKey();
    return res.status(200).json({
      ok: true,
      name: key,
      weekScore: p.weekScore || 0,
      dailyAddDone: (p.dailyAdd && p.dailyAdd[today]) || 0,
      dailyMulDone: (p.dailyMul && p.dailyMul[today]) || 0,
    });
  }

  // ── POST /api/math?action=score ──
  if (req.method === 'POST' && action === 'score') {
    const { name, delta, mode } = req.body; // mode: 'add' | 'mul'
    if (!name || delta === undefined) return res.status(400).json({ ok: false });
    let players = await getPlayers();
    const key = Object.keys(players).find(k => k.toLowerCase() === name.toLowerCase());
    if (!key) return res.status(404).json({ ok: false });
    const p = players[key];
    p.weekScore = Math.max(0, (p.weekScore || 0) + delta);
    await savePlayers(players);
    return res.status(200).json({ ok: true, weekScore: p.weekScore });
  }

  // ── POST /api/math?action=daily ──  (track daily question count)
  if (req.method === 'POST' && action === 'daily') {
    const { name, mode, count } = req.body;
    let players = await getPlayers();
    const key = Object.keys(players).find(k => k.toLowerCase() === name.toLowerCase());
    if (!key) return res.status(404).json({ ok: false });
    const p = players[key];
    const today = getTodayKey();
    if (!p.dailyAdd) p.dailyAdd = {};
    if (!p.dailyMul) p.dailyMul = {};
    if (mode === 'add') p.dailyAdd[today] = count;
    else p.dailyMul[today] = count;
    await savePlayers(players);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
