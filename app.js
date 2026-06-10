const $ = selector => document.querySelector(selector);
const state = {
  roomId: new URLSearchParams(location.search).get("room"),
  playerId: "",
  room: null,
  events: null,
  promptedJoin: false
};

const landing = $("#landing");
const game = $("#game");
const nameInput = $("#nameInput");
const roundSelect = $("#roundSelect");
const botSelect = $("#botSelect");
const addBotSelect = $("#addBotSelect");
const landingError = $("#landingError");
const gameError = $("#gameError");

$("#createBtn").addEventListener("click", createRoom);
$("#joinBtn").addEventListener("click", joinInvite);
$("#addBotsBtn").addEventListener("click", addBots);
$("#copyInviteBtn").addEventListener("click", copyInvite);
$("#startBtn").addEventListener("click", startGame);
$("#nextRoundBtn").addEventListener("click", nextRound);
$("#actionButtons").addEventListener("click", event => {
  const button = event.target.closest("button[data-move]");
  if (button) sendAction(button.dataset.move);
});

if (state.roomId) {
  state.playerId = getStoredPlayerId(state.roomId);
  showGame();
  if (state.playerId) connect();
  else joinInvite();
}

async function createRoom() {
  clearErrors();
  try {
    const data = await api("/api/create", {
      name: nameInput.value,
      rounds: roundSelect.value,
      botCount: botSelect.value
    });
    enterRoom(data.roomId, data.playerId);
  } catch (error) {
    landingError.textContent = error.message;
  }
}

async function joinInvite() {
  clearErrors();
  const roomId = state.roomId || prompt("Paste room code or invite link:");
  if (!roomId) return;
  const cleanRoom = extractRoomId(roomId);
  const name = nameInput.value || prompt("Your player name:");
  if (!name) return;
  try {
    const data = await api(`/api/rooms/${cleanRoom}/join`, { name });
    enterRoom(data.roomId, data.playerId);
  } catch (error) {
    landingError.textContent = error.message;
    gameError.textContent = error.message;
  }
}

function enterRoom(roomId, playerId) {
  state.roomId = roomId;
  state.playerId = playerId;
  localStorage.setItem(playerStorageKey(roomId), playerId);
  localStorage.removeItem("loopHoldemPlayerId");
  history.replaceState(null, "", `/?room=${roomId}`);
  showGame();
  connect();
}

function showGame() {
  landing.classList.add("hidden");
  game.classList.remove("hidden");
}

function connect() {
  if (state.events) state.events.close();
  state.events = new EventSource(`/api/rooms/${state.roomId}/events?playerId=${encodeURIComponent(state.playerId)}`);
  state.events.addEventListener("state", event => {
    state.room = JSON.parse(event.data);
    promptToJoinIfNeeded();
    render();
  });
  state.events.onerror = () => {
    gameError.textContent = "Connection paused. Reconnecting...";
  };
}

function promptToJoinIfNeeded() {
  const me = state.room.players.find(player => player.id === state.playerId);
  if (me || state.promptedJoin || state.room.phase !== "waiting") return;
  state.promptedJoin = true;
  localStorage.removeItem(playerStorageKey(state.roomId));
  state.playerId = "";
  gameError.textContent = "You are watching. Enter a name to sit before the game starts.";
  setTimeout(joinInvite, 50);
}

function getStoredPlayerId(roomId) {
  return localStorage.getItem(playerStorageKey(roomId)) || "";
}

function playerStorageKey(roomId) {
  return `loopHoldemPlayerId:${roomId}`;
}

async function startGame() {
  clearErrors();
  try {
    await api(`/api/rooms/${state.roomId}/start`, {
      playerId: state.playerId,
      rounds: roundSelect.value
    });
  } catch (error) {
    gameError.textContent = error.message;
  }
}

async function addBots() {
  clearErrors();
  try {
    await api(`/api/rooms/${state.roomId}/bots`, {
      playerId: state.playerId,
      count: addBotSelect.value
    });
  } catch (error) {
    gameError.textContent = error.message;
  }
}

async function nextRound() {
  clearErrors();
  try {
    await api(`/api/rooms/${state.roomId}/continue`, { playerId: state.playerId });
  } catch (error) {
    gameError.textContent = error.message;
  }
}

async function sendAction(move) {
  clearErrors();
  try {
    await api(`/api/rooms/${state.roomId}/act`, { playerId: state.playerId, move });
  } catch (error) {
    gameError.textContent = error.message;
  }
}

async function api(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "Request failed.");
  return data;
}

async function copyInvite() {
  const invite = `${location.origin}/?room=${state.roomId}`;
  await navigator.clipboard.writeText(invite);
  $("#inviteText").textContent = `Invite copied: ${invite}`;
}

function render() {
  const room = state.room;
  if (!room) return;
  const me = room.players.find(player => player.id === state.playerId);
  $("#roomId").textContent = room.id;
  $("#statusText").textContent = room.message;
  $("#roundText").textContent = `Round ${room.round} / ${room.maxRounds}`;
  $("#potText").textContent = `Pot ${room.pot}`;
  $("#inviteText").textContent = `${location.origin}/?room=${room.id}`;
  $("#board").innerHTML = renderCards(room.board, 5);
  $("#myCards").innerHTML = renderCards(me ? me.cards : [], 2);
  $("#players").innerHTML = room.players.map(renderPlayer).join("");
  $("#log").innerHTML = room.actionLog.map(item => `<div>${escapeHtml(item)}</div>`).join("");

  const isHost = room.hostId === state.playerId;
  const canAddBots = isHost && room.phase === "waiting" && room.players.length < 7;
  $("#addBotSelect").classList.toggle("hidden", !canAddBots);
  $("#addBotsBtn").classList.toggle("hidden", !canAddBots);
  $("#addBotsBtn").disabled = !canAddBots;
  $("#startBtn").classList.toggle("hidden", !(isHost && ["waiting", "between"].includes(room.phase)));
  $("#startBtn").disabled = room.players.length < 3 || room.players.length > 7;
  $("#nextRoundBtn").classList.toggle("hidden", !(isHost && room.phase === "showdown"));

  const myTurn = room.turnPlayerId === state.playerId;
  const toCall = me ? Math.max(0, room.currentBet - me.bet) : 0;
  for (const button of document.querySelectorAll("#actionButtons button")) {
    button.disabled = !myTurn;
    if (button.dataset.move === "check") button.disabled = !myTurn || toCall > 0;
    if (button.dataset.move === "call") {
      button.disabled = !myTurn || toCall === 0;
      button.textContent = toCall > 0 ? `Call ${toCall}` : "Call";
    }
    if (button.dataset.move === "raise") button.disabled = !myTurn || !me || me.points <= toCall;
  }
}

function renderPlayer(player) {
  const flags = [
    player.isDealer ? "D" : "",
    player.isBot ? "Bot" : "",
    player.folded ? "Fold" : "",
    player.allIn ? "All In" : "",
    player.out ? "Out" : ""
  ].filter(Boolean).join(" ");
  return `
    <article class="player ${player.isTurn ? "turn" : ""} ${player.isWinner ? "winner" : ""}">
      <div class="player-head">
        <span class="name">${escapeHtml(player.name)}</span>
        <span class="badge">${flags || "Play"}</span>
      </div>
      <div class="stack">
        <span>${player.points} pts</span>
        <span class="badge">Bet ${player.bet}</span>
      </div>
      <div class="cards">${renderCards(player.cards, 2)}</div>
    </article>
  `;
}

function renderCards(cards, slots) {
  const filled = [...cards];
  while (filled.length < slots) filled.push("");
  return filled.map(card => {
    if (!card) return `<div class="card back"><span></span></div>`;
    if (card === "BACK") return `<div class="card back"><span></span></div>`;
    const parsed = parseCard(card);
    return `
      <div class="card ${parsed.red ? "red" : ""}">
        <span class="corner top">${parsed.rank}<small>${parsed.suit}</small></span>
        <span class="pip">${parsed.suit}</span>
        <span class="corner bottom">${parsed.rank}<small>${parsed.suit}</small></span>
      </div>
    `;
  }).join("");
}

function parseCard(card) {
  const suitCode = card.slice(-1);
  const rank = card.slice(0, -1);
  const suits = { H: "♥", D: "♦", S: "♠", C: "♣" };
  return {
    rank,
    suit: suits[suitCode] || suitCode,
    red: suitCode === "H" || suitCode === "D"
  };
}

function extractRoomId(value) {
  try {
    const url = new URL(value);
    return url.searchParams.get("room") || value.trim();
  } catch (_) {
    return value.trim().toUpperCase();
  }
}

function clearErrors() {
  landingError.textContent = "";
  gameError.textContent = "";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}
