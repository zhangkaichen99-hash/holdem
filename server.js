const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 4173);
const ROOT_DIR = __dirname;
const rooms = new Map();

const SUITS = ["s", "h", "d", "c"];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };
const SMALL_BLIND = 1;
const BIG_BLIND = 2;
const RAISE_STEP = 5;
const BOT_NAMES = ["Ada", "Turing", "River", "Chip", "Nova", "Byte"];

function id(len = 6) {
  return crypto.randomBytes(len).toString("base64url").slice(0, len).toUpperCase();
}

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ rank, suit });
  }
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardText(card) {
  return `${RANK_LABEL[card.rank] || card.rank}${card.suit.toUpperCase()}`;
}

function createRoom({ name, rounds, botCount }) {
  const roomId = id(6);
  const hostId = id(12);
  const room = {
    id: roomId,
    hostId,
    maxRounds: clampRounds(rounds),
    round: 0,
    dealerIndex: 0,
    phase: "waiting",
    message: "Waiting for players.",
    players: [],
    deck: [],
    board: [],
    pot: 0,
    currentBet: 0,
    turnPlayerId: null,
    winnerIds: [],
    handSummary: "",
    clients: new Set(),
    botTimer: null,
    actionLog: []
  };
  rooms.set(roomId, room);
  addPlayer(room, hostId, name || "Host");
  addBots(room, clampBotCount(botCount, room.players.length));
  return { room, playerId: hostId };
}

function clampRounds(value) {
  const rounds = Number(value);
  return [5, 10, 15, 20].includes(rounds) ? rounds : 10;
}

function clampBotCount(value, currentPlayers = 0) {
  const count = Math.max(0, Math.min(6, Number(value) || 0));
  return Math.min(count, 7 - currentPlayers);
}

function addPlayer(room, playerId, rawName, isBot = false) {
  if (room.phase !== "waiting") throw new Error("This game already started.");
  if (room.players.length >= 7) throw new Error("This table is full.");
  const name = String(rawName || "Player").trim().slice(0, 18) || "Player";
  if (room.players.some(player => player.name.toLowerCase() === name.toLowerCase())) {
    throw new Error("That name is already seated.");
  }
  room.players.push({
    id: playerId,
    name,
    points: 100,
    cards: [],
    folded: false,
    allIn: false,
    bet: 0,
    acted: false,
    out: false,
    isBot
  });
  log(room, `${name} ${isBot ? "booted up" : "joined"}.`);
}

function addBots(room, count) {
  const added = [];
  for (let i = 0; i < count; i += 1) {
    const base = BOT_NAMES.find(name => !room.players.some(player => player.name === name)) || `Bot ${room.players.length}`;
    const name = uniqueBotName(room, base);
    const botId = `BOT_${id(9)}`;
    addPlayer(room, botId, name, true);
    added.push(name);
  }
  return added;
}

function uniqueBotName(room, base) {
  if (!room.players.some(player => player.name === base)) return base;
  let index = 2;
  while (room.players.some(player => player.name === `${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function log(room, text) {
  room.actionLog.unshift(text);
  room.actionLog = room.actionLog.slice(0, 7);
}

function startGame(room) {
  if (room.phase !== "waiting" && room.phase !== "between") throw new Error("Game is already running.");
  const seated = room.players.filter(player => !player.out);
  if (seated.length < 3) throw new Error("Texas Hold'em needs at least 3 players.");
  if (seated.length > 7) throw new Error("Maximum is 7 players.");
  if (room.round >= room.maxRounds) throw new Error("The selected round limit is complete.");
  startRound(room);
  scheduleBots(room);
}

function startRound(room) {
  room.round += 1;
  room.phase = "preflop";
  room.deck = makeDeck();
  room.board = [];
  room.pot = 0;
  room.currentBet = BIG_BLIND;
  room.winnerIds = [];
  room.handSummary = "";
  room.message = `Round ${room.round} of ${room.maxRounds}.`;

  for (const player of room.players) {
    player.cards = [];
    player.folded = false;
    player.allIn = false;
    player.bet = 0;
    player.acted = false;
    player.out = player.points <= 0;
  }

  normalizeDealer(room);
  const active = activePlayers(room);
  for (let i = 0; i < 2; i += 1) {
    for (const player of active) player.cards.push(room.deck.pop());
  }

  const small = playerByIndex(room, nextActiveIndex(room, room.dealerIndex));
  const big = playerByIndex(room, nextActiveIndex(room, room.players.indexOf(small)));
  postBlind(room, small, SMALL_BLIND);
  postBlind(room, big, BIG_BLIND);
  room.turnPlayerId = playerByIndex(room, nextActiveIndex(room, room.players.indexOf(big))).id;
  log(room, `Round ${room.round} started. ${small.name} posts ${SMALL_BLIND}, ${big.name} posts ${BIG_BLIND}.`);
}

function normalizeDealer(room) {
  if (!room.players[room.dealerIndex] || room.players[room.dealerIndex].points <= 0) {
    room.dealerIndex = nextActiveIndex(room, room.dealerIndex - 1);
  }
}

function postBlind(room, player, amount) {
  const paid = Math.min(player.points, amount);
  player.points -= paid;
  player.bet += paid;
  player.allIn = player.points === 0;
  room.pot += paid;
}

function activePlayers(room) {
  return room.players.filter(player => !player.out && player.points + player.bet > 0);
}

function livePlayers(room) {
  return room.players.filter(player => !player.out && !player.folded && (player.points + player.bet > 0 || player.allIn));
}

function playerByIndex(room, index) {
  return room.players[((index % room.players.length) + room.players.length) % room.players.length];
}

function nextActiveIndex(room, fromIndex) {
  for (let step = 1; step <= room.players.length; step += 1) {
    const index = (fromIndex + step) % room.players.length;
    const player = room.players[index];
    if (!player.out && player.points + player.bet > 0) return index;
  }
  return 0;
}

function act(room, playerId, move) {
  if (!["preflop", "flop", "turn", "river"].includes(room.phase)) throw new Error("No action is needed right now.");
  if (room.turnPlayerId !== playerId) throw new Error("It is not your turn.");
  const player = room.players.find(item => item.id === playerId);
  if (!player || player.folded || player.allIn) throw new Error("This player cannot act.");

  const toCall = Math.max(0, room.currentBet - player.bet);
  if (move === "fold") {
    player.folded = true;
    player.acted = true;
    log(room, `${player.name} folds.`);
  } else if (move === "check") {
    if (toCall > 0) throw new Error("You must call, raise, all-in, or fold.");
    player.acted = true;
    log(room, `${player.name} checks.`);
  } else if (move === "call") {
    pay(room, player, toCall);
    player.acted = true;
    log(room, `${player.name} calls ${toCall}.`);
  } else if (move === "raise") {
    const targetBet = room.currentBet + RAISE_STEP;
    const cost = targetBet - player.bet;
    if (player.points <= toCall) throw new Error("Not enough points to raise.");
    pay(room, player, cost);
    room.currentBet = player.bet;
    for (const other of livePlayers(room)) {
      if (other.id !== player.id && !other.allIn) other.acted = false;
    }
    player.acted = true;
    log(room, `${player.name} raises to ${room.currentBet}.`);
  } else if (move === "allin") {
    const oldBet = player.bet;
    pay(room, player, player.points);
    if (player.bet > room.currentBet) {
      room.currentBet = player.bet;
      for (const other of livePlayers(room)) {
        if (other.id !== player.id && !other.allIn) other.acted = false;
      }
    }
    player.acted = true;
    log(room, `${player.name} goes all-in for ${player.bet - oldBet}.`);
  } else {
    throw new Error("Unknown move.");
  }

  settleIfNeeded(room);
}

function scheduleBots(room) {
  clearTimeout(room.botTimer);
  if (!["preflop", "flop", "turn", "river"].includes(room.phase)) return;
  const bot = room.players.find(player => player.id === room.turnPlayerId && player.isBot);
  if (!bot) return;
  room.botTimer = setTimeout(() => {
    try {
      const move = chooseBotMove(room, bot);
      act(room, bot.id, move);
      broadcast(room);
      scheduleBots(room);
    } catch (error) {
      log(room, `${bot.name} waits.`);
      broadcast(room);
    }
  }, 650);
}

function chooseBotMove(room, player) {
  const toCall = Math.max(0, room.currentBet - player.bet);
  const strength = botStrength(room, player);
  const pressure = toCall / Math.max(1, player.points + player.bet);

  if (toCall === 0) {
    if (strength > 0.78 && player.points > RAISE_STEP && Math.random() < 0.55) return "raise";
    if (strength > 0.92 && player.points > 0 && Math.random() < 0.16) return "allin";
    return "check";
  }

  if (player.points <= toCall) return strength > 0.35 ? "call" : "fold";
  if (strength > 0.82 && player.points > toCall + RAISE_STEP && Math.random() < 0.5) return "raise";
  if (strength < 0.32 && pressure > 0.12) return "fold";
  if (strength < 0.22 && Math.random() < 0.45) return "fold";
  return "call";
}

function botStrength(room, player) {
  if (room.board.length >= 3) {
    const score = bestHand([...player.cards, ...room.board]);
    const kicker = (score.values[0] || 0) / 14;
    return Math.min(1, score.rank / 8 + kicker * 0.12);
  }

  const [a, b] = player.cards.map(card => card.rank).sort((x, y) => y - x);
  let strength = (a + b) / 28;
  if (a === b) strength += 0.28;
  if (player.cards[0].suit === player.cards[1].suit) strength += 0.08;
  if (Math.abs(a - b) <= 2) strength += 0.05;
  return Math.min(1, strength);
}

function pay(room, player, amount) {
  const paid = Math.min(player.points, Math.max(0, amount));
  player.points -= paid;
  player.bet += paid;
  player.allIn = player.points === 0;
  room.pot += paid;
}

function settleIfNeeded(room) {
  const live = livePlayers(room);
  if (live.length === 1) {
    award(room, [live[0]], `${live[0].name} wins after everyone else folds.`);
    return;
  }

  const canAct = live.filter(player => !player.allIn);
  const bettingDone = canAct.length === 0 || canAct.every(player => player.acted && player.bet === room.currentBet);
  if (!bettingDone) {
    room.turnPlayerId = nextTurnId(room);
    return;
  }

  if (room.phase === "river" || canAct.length === 0) {
    while (room.board.length < 5) room.board.push(room.deck.pop());
    showdown(room);
    return;
  }

  nextStreet(room);
}

function nextTurnId(room) {
  const start = room.players.findIndex(player => player.id === room.turnPlayerId);
  for (let step = 1; step <= room.players.length; step += 1) {
    const player = playerByIndex(room, start + step);
    if (!player.out && !player.folded && !player.allIn && player.bet < room.currentBet) return player.id;
  }
  for (let step = 1; step <= room.players.length; step += 1) {
    const player = playerByIndex(room, start + step);
    if (!player.out && !player.folded && !player.allIn && !player.acted) return player.id;
  }
  return null;
}

function nextStreet(room) {
  for (const player of room.players) {
    player.bet = 0;
    player.acted = false;
  }
  room.currentBet = 0;
  if (room.phase === "preflop") {
    room.board.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    room.phase = "flop";
  } else if (room.phase === "flop") {
    room.board.push(room.deck.pop());
    room.phase = "turn";
  } else {
    room.board.push(room.deck.pop());
    room.phase = "river";
  }
  const first = playerByIndex(room, nextActiveIndex(room, room.dealerIndex));
  room.turnPlayerId = first.id;
  room.message = `${room.phase.toUpperCase()} betting.`;
  log(room, `${room.phase.toUpperCase()} dealt.`);
}

function showdown(room) {
  const contenders = livePlayers(room);
  const scored = contenders.map(player => ({
    player,
    score: bestHand([...player.cards, ...room.board])
  })).sort((a, b) => compareScore(b.score, a.score));
  const best = scored[0].score;
  const winners = scored.filter(item => compareScore(item.score, best) === 0).map(item => item.player);
  const verb = winners.length === 1 ? "wins" : "win";
  award(room, winners, `${winners.map(player => player.name).join(", ")} ${verb} with ${best.name}.`);
}

function award(room, winners, summary) {
  const share = Math.floor(room.pot / winners.length);
  let remainder = room.pot - share * winners.length;
  for (const winner of winners) {
    winner.points += share + (remainder > 0 ? 1 : 0);
    remainder -= 1;
  }
  room.winnerIds = winners.map(player => player.id);
  room.handSummary = summary;
  room.message = summary;
  room.phase = "showdown";
  room.turnPlayerId = null;
  room.pot = 0;
  for (const player of room.players) player.out = player.points <= 0;
  log(room, summary);
}

function continueGame(room) {
  if (room.phase !== "showdown") throw new Error("Finish the current hand first.");
  const remaining = room.players.filter(player => player.points > 0);
  if (room.round >= room.maxRounds || remaining.length < 3) {
    room.phase = "finished";
    room.message = room.round >= room.maxRounds ? "Round limit reached." : "Not enough players with points remain.";
    log(room, "Game finished.");
    broadcast(room);
    return;
  }
  room.dealerIndex = nextActiveIndex(room, room.dealerIndex);
  startRound(room);
  scheduleBots(room);
}

function bestHand(cards) {
  const combos = choose(cards, 5);
  let best = null;
  for (const combo of combos) {
    const score = scoreFive(combo);
    if (!best || compareScore(score, best) > 0) best = score;
  }
  return best;
}

function choose(items, size, start = 0, picked = [], out = []) {
  if (picked.length === size) {
    out.push([...picked]);
    return out;
  }
  for (let i = start; i <= items.length - (size - picked.length); i += 1) {
    picked.push(items[i]);
    choose(items, size, i + 1, picked, out);
    picked.pop();
  }
  return out;
}

function scoreFive(cards) {
  const ranks = cards.map(card => card.rank).sort((a, b) => b - a);
  const counts = new Map();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every(card => card.suit === cards[0].suit);
  const straightHigh = getStraightHigh(ranks);

  if (flush && straightHigh) return named(8, [straightHigh], "straight flush");
  if (groups[0][1] === 4) return named(7, [groups[0][0], ...ranks.filter(rank => rank !== groups[0][0])], "four of a kind");
  if (groups[0][1] === 3 && groups[1][1] === 2) return named(6, [groups[0][0], groups[1][0]], "full house");
  if (flush) return named(5, ranks, "flush");
  if (straightHigh) return named(4, [straightHigh], "straight");
  if (groups[0][1] === 3) return named(3, [groups[0][0], ...ranks.filter(rank => rank !== groups[0][0])], "three of a kind");
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairs = groups.filter(group => group[1] === 2).map(group => group[0]).sort((a, b) => b - a);
    return named(2, [...pairs, ...ranks.filter(rank => !pairs.includes(rank))], "two pair");
  }
  if (groups[0][1] === 2) return named(1, [groups[0][0], ...ranks.filter(rank => rank !== groups[0][0])], "one pair");
  return named(0, ranks, "high card");
}

function named(rank, values, name) {
  return { rank, values, name };
}

function getStraightHigh(ranks) {
  const unique = [...new Set(ranks)].sort((a, b) => b - a);
  if (unique.includes(14)) unique.push(1);
  for (let i = 0; i <= unique.length - 5; i += 1) {
    const run = unique.slice(i, i + 5);
    if (run[0] - run[4] === 4) return run[0];
  }
  return 0;
}

function compareScore(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.max(a.values.length, b.values.length); i += 1) {
    const diff = (a.values[i] || 0) - (b.values[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function publicState(room, playerId) {
  const state = {
    id: room.id,
    hostId: room.hostId,
    maxRounds: room.maxRounds,
    round: room.round,
    dealerIndex: room.dealerIndex,
    phase: room.phase,
    message: room.message,
    board: room.board.map(cardText),
    pot: room.pot,
    currentBet: room.currentBet,
    turnPlayerId: room.turnPlayerId,
    winnerIds: room.winnerIds,
    handSummary: room.handSummary,
    actionLog: room.actionLog,
    players: room.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      points: player.points,
      cards: player.id === playerId || ["showdown", "finished"].includes(room.phase) ? player.cards.map(cardText) : player.cards.map(() => "BACK"),
      folded: player.folded,
      allIn: player.allIn,
      bet: player.bet,
      out: player.out,
      isBot: player.isBot,
      isDealer: index === room.dealerIndex,
      isTurn: player.id === room.turnPlayerId,
      isWinner: room.winnerIds.includes(player.id)
    }))
  };
  return state;
}

function broadcast(room) {
  for (const client of room.clients) {
    client.write(`event: state\ndata: ${JSON.stringify(publicState(room, client.playerId))}\n\n`);
  }
}

function sendError(res, error) {
  json(res, 400, { error: error.message || String(error) });
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "POST" && url.pathname === "/api/create") {
      const body = await readBody(req);
      const { room, playerId } = createRoom(body);
      broadcast(room);
      return json(res, 200, { roomId: room.id, playerId });
    }

    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/([^/]+))?$/);
    if (!match) return json(res, 404, { error: "Not found" });
    const room = rooms.get(match[1]);
    if (!room) return json(res, 404, { error: "Room not found" });
    const actionName = match[2];

    if (req.method === "GET" && !actionName) {
      const playerId = url.searchParams.get("playerId");
      return json(res, 200, publicState(room, playerId));
    }

    if (req.method === "GET" && actionName === "events") {
      const playerId = url.searchParams.get("playerId");
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      res.write(`event: state\ndata: ${JSON.stringify(publicState(room, playerId))}\n\n`);
      const client = Object.assign(res, { playerId });
      room.clients.add(client);
      req.on("close", () => room.clients.delete(client));
      return;
    }

    const body = req.method === "POST" ? await readBody(req) : {};
    if (req.method === "POST" && actionName === "join") {
      const playerId = id(12);
      addPlayer(room, playerId, body.name);
      broadcast(room);
      return json(res, 200, { roomId: room.id, playerId });
    }
    if (req.method === "POST" && actionName === "bots") {
      requireHost(room, body.playerId);
      const added = addBots(room, clampBotCount(body.count, room.players.length));
      broadcast(room);
      return json(res, 200, { added });
    }
    if (req.method === "POST" && actionName === "start") {
      requireHost(room, body.playerId);
      if (body.rounds) room.maxRounds = clampRounds(body.rounds);
      startGame(room);
      broadcast(room);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && actionName === "act") {
      act(room, body.playerId, body.move);
      broadcast(room);
      scheduleBots(room);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && actionName === "continue") {
      requireHost(room, body.playerId);
      continueGame(room);
      broadcast(room);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    sendError(res, error);
  }
}

function requireHost(room, playerId) {
  if (room.hostId !== playerId) throw new Error("Only the host can do that.");
}

function serveStatic(req, res, url) {
  const safePath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const rootPath = path.normalize(path.join(ROOT_DIR, safePath));

  if (!rootPath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(rootPath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(rootPath);
    const types = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "text/javascript",
      ".json": "application/json"
    };
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) handleApi(req, res, url);
  else serveStatic(req, res, url);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Loop Hold'em running at http://localhost:${PORT}`);
  });
}

module.exports = { bestHand, compareScore, scoreFive, cardText, createRoom, server };
