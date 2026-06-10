const assert = require("assert");
const { bestHand, compareScore, createRoom, scoreFive } = require("../server");

function c(text) {
  const rankText = text.slice(0, -1);
  const suit = text.slice(-1).toLowerCase();
  const labels = { J: 11, Q: 12, K: 13, A: 14 };
  return { rank: labels[rankText] || Number(rankText), suit };
}

function hand(cards) {
  return cards.map(c);
}

const straightFlush = scoreFive(hand(["10H", "JH", "QH", "KH", "AH"]));
const quads = scoreFive(hand(["9H", "9S", "9D", "9C", "2H"]));
assert(compareScore(straightFlush, quads) > 0, "straight flush beats four of a kind");

const wheel = scoreFive(hand(["AH", "2S", "3D", "4C", "5H"]));
assert.equal(wheel.name, "straight");
assert.deepEqual(wheel.values, [5]);

const fullHouse = bestHand(hand(["AH", "AS", "AD", "KC", "KH", "2D", "3C"]));
assert.equal(fullHouse.name, "full house");
assert.deepEqual(fullHouse.values, [14, 13]);

const flush = bestHand(hand(["2H", "5H", "8H", "10H", "KH", "AS", "AD"]));
const trips = bestHand(hand(["AS", "AD", "AC", "10H", "8S", "5C", "2D"]));
assert(compareScore(flush, trips) > 0, "flush beats three of a kind");

const { room } = createRoom({ name: "Solo", rounds: 5, botCount: 2 });
assert.equal(room.players.length, 3, "solo room includes two bots");
assert.equal(room.players.filter(player => player.isBot).length, 2, "bot players are marked");
assert.equal(room.players[0].points, 100, "human starts with 100 points");
assert(room.players.slice(1).every(player => player.points === 100), "bots start with 100 points");

console.log("Poker tests passed.");
