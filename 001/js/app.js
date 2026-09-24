// ==============================================================================
// MQTT 賓果連線遊戲
// 架構：完全沒有後端伺服器，所有溝通都透過 MQTT broker (mosquitto) 的
// publish/subscribe 完成。房間裡第一個按「建立房間」的瀏覽器分頁擔任「主持人」，
// 負責抽號、彙整玩家名單、裁定 BINGO 宣告是否有效；其他分頁都是「玩家」，
// 只會發布加入/離開/BINGO 宣告訊息，實際的房間狀態一律以主持人發布的
// retained 訊息為準。
// ==============================================================================

const COLUMN_RANGES = {
  B: [1, 15],
  I: [16, 30],
  N: [31, 45],
  G: [46, 60],
  O: [61, 75],
};
const COLUMN_LETTERS = ['B', 'I', 'N', 'G', 'O'];

let client = null;
let role = null; // 'host' | 'player'
let room = null;
let myId = null;
let myName = null;
let hostAlsoPlays = false;

let calledNumbers = [];      // 目前已叫出的號碼 (由主持人發布，大家都收到同一份)
let roomStatus = 'waiting';  // 'waiting' | 'playing' | 'ended'
let winnerInfo = null;

// 主持人專用：彙整玩家名單 (id -> {name, role})
const roster = new Map();

// 我自己的賓果卡（玩家一定有；主持人若勾選「也要玩」才會有）
let myCard = null;      // { grid: [[num|'FREE',...]x5], marked: [[bool,...]x5] }
let bingoClaimed = false; // 避免同一張卡重複宣告

// ------------------------------------------------------------------
// 工具函式
// ------------------------------------------------------------------

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function randomRoomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function topic(suffix) {
  return `bingo/${room}/${suffix}`;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickColumnNumbers(min, max, count) {
  const pool = [];
  for (let n = min; n <= max; n++) pool.push(n);
  return shuffle(pool).slice(0, count);
}

// 產生一張標準 75 球賓果卡：B(1-15) I(16-30) N(31-45,中間 FREE) G(46-60) O(61-75)
function generateCard() {
  const cols = COLUMN_LETTERS.map((letter, idx) => {
    const [min, max] = COLUMN_RANGES[letter];
    const count = idx === 2 ? 4 : 5; // N 欄只需要 4 個數字，中間留給 FREE
    return pickColumnNumbers(min, max, count);
  });

  const grid = [];
  const marked = [];
  for (let r = 0; r < 5; r++) {
    const gridRow = [];
    const markedRow = [];
    for (let c = 0; c < 5; c++) {
      if (c === 2 && r === 2) {
        gridRow.push('FREE');
        markedRow.push(true);
      } else {
        const colValues = cols[c];
        const valueIndex = c === 2 && r > 2 ? r - 1 : r; // N 欄跳過中間格
        gridRow.push(colValues[valueIndex]);
        markedRow.push(false);
      }
    }
    grid.push(gridRow);
    marked.push(markedRow);
  }
  return { grid, marked };
}

const WIN_LINES = (() => {
  const lines = [];
  for (let r = 0; r < 5; r++) lines.push([0, 1, 2, 3, 4].map(c => [r, c]));
  for (let c = 0; c < 5; c++) lines.push([0, 1, 2, 3, 4].map(r => [r, c]));
  lines.push([0, 1, 2, 3, 4].map(i => [i, i]));
  lines.push([0, 1, 2, 3, 4].map(i => [i, 4 - i]));
  return lines;
})();

function findCompletedLine(card) {
  for (const line of WIN_LINES) {
    if (line.every(([r, c]) => card.marked[r][c])) return line;
  }
  return null;
}

function describeLine(line) {
  const rows = new Set(line.map(([r]) => r));
  const cols = new Set(line.map(([, c]) => c));
  if (rows.size === 1) return `第 ${[...rows][0] + 1} 列（橫排）`;
  if (cols.size === 1) return `第 ${COLUMN_LETTERS[[...cols][0]]} 欄（直排）`;
  return line[0][0] === line[0][1] ? '左上到右下對角線' : '右上到左下對角線';
}

// ------------------------------------------------------------------
// 畫面切換
// ------------------------------------------------------------------

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
  document.getElementById(`screen-${name}`).classList.remove('hidden');
}

function setConnStatus(state, text) {
  const el = document.getElementById('connStatus');
  el.className = `conn-status ${state}`;
  el.textContent = text;
}

// ------------------------------------------------------------------
// MQTT 連線
// ------------------------------------------------------------------

function connectAndEnterRoom(chosenRole) {
  const host = document.getElementById('brokerHost').value.trim();
  const port = document.getElementById('brokerPort').value.trim() || '9001';
  const nickInput = document.getElementById('nickname').value.trim();
  const roomInput = document.getElementById('roomCode').value.trim();
  const errEl = document.getElementById('lobbyError');
  errEl.textContent = '';

  if (!host) { errEl.textContent = '請輸入 Broker 位址'; return; }
  if (!nickInput) { errEl.textContent = '請輸入暱稱'; return; }
  if (!roomInput) { errEl.textContent = '請輸入房間代碼'; return; }

  role = chosenRole;
  room = roomInput;
  myName = nickInput;
  myId = randomId();
  hostAlsoPlays = role === 'host' && document.getElementById('hostAlsoPlays').checked;

  const url = `ws://${host}:${port}`;
  setConnStatus('connecting', '連線中…');

  client = mqtt.connect(url, {
    clientId: `bingo_${room}_${myId}`,
    clean: true,
    connectTimeout: 8000,
    reconnectPeriod: 2000,
    will: {
      topic: topic('leave'),
      payload: JSON.stringify({ id: myId, name: myName }),
      qos: 1,
      retain: false,
    },
  });

  client.on('connect', () => {
    setConnStatus('online', `已連線 ${host}:${port}`);
    onConnected();
  });
  client.on('reconnect', () => setConnStatus('connecting', '重新連線中…'));
  client.on('close', () => setConnStatus('offline', '已斷線'));
  client.on('error', (err) => {
    console.error('MQTT error', err);
    errEl.textContent = 'MQTT 連線失敗，請確認 Broker 位址/Port 是否正確。';
    setConnStatus('offline', '連線失敗');
  });
  client.on('message', onMessage);
}

function onConnected() {
  client.subscribe(topic('state'), { qos: 1 });
  client.subscribe(topic('calls'), { qos: 1 });
  client.subscribe(topic('players'), { qos: 1 });
  client.subscribe(topic('winner'), { qos: 1 });
  client.subscribe(topic('join'), { qos: 1 });
  client.subscribe(topic('leave'), { qos: 1 });
  if (role === 'host') client.subscribe(topic('claim'), { qos: 1 });

  // 廣播自己加入房間
  client.publish(topic('join'), JSON.stringify({ id: myId, name: myName, role }), { qos: 1 });

  if (role === 'host') {
    roster.set(myId, { name: myName, role: 'host' });
    republishRoster();
    publishState('waiting');
    document.getElementById('hostRoomCode').textContent = room;
    if (hostAlsoPlays) {
      document.getElementById('hostOwnCardWrap').classList.remove('hidden');
    }
    showScreen('host');
    renderCalledBoard('calledBoard');
  } else {
    document.getElementById('playerRoomCode').textContent = room;
    myCard = generateCard();
    renderCard('playerBingoCard', myCard);
    showScreen('player');
    renderCalledBoard('calledBoardP');
  }
}

// ------------------------------------------------------------------
// 發布輔助函式（主持人專用：state / calls / players / winner 都是 retained）
// ------------------------------------------------------------------

function publishState(status) {
  roomStatus = status;
  client.publish(topic('state'), JSON.stringify({ status, hostName: myName, ts: Date.now() }),
    { qos: 1, retain: true });
  updateStateText();
}

function publishCalls() {
  client.publish(topic('calls'), JSON.stringify({ numbers: calledNumbers, ts: Date.now() }),
    { qos: 1, retain: true });
}

function republishRoster() {
  const list = [...roster.entries()].map(([id, info]) => ({ id, ...info }));
  client.publish(topic('players'), JSON.stringify({ list }), { qos: 1, retain: true });
}

function publishWinner(info) {
  winnerInfo = info;
  client.publish(topic('winner'), JSON.stringify(info), { qos: 1, retain: true });
}

function clearWinner() {
  winnerInfo = null;
  client.publish(topic('winner'), '', { qos: 1, retain: true }); // 空 payload 清掉 retained 訊息
}

// ------------------------------------------------------------------
// 收到 MQTT 訊息
// ------------------------------------------------------------------

function onMessage(t, payloadBuf) {
  const payload = payloadBuf.toString();
  const suffix = t.split('/').slice(2).join('/');

  if (suffix === 'join' && role === 'host') {
    const info = JSON.parse(payload);
    roster.set(info.id, { name: info.name, role: info.role });
    republishRoster();
    return;
  }

  if (suffix === 'leave' && role === 'host') {
    const info = JSON.parse(payload);
    roster.delete(info.id);
    republishRoster();
    return;
  }

  if (suffix === 'players') {
    if (!payload) return;
    const { list } = JSON.parse(payload);
    renderPlayerList(list);
    return;
  }

  if (suffix === 'state') {
    if (!payload) return;
    const state = JSON.parse(payload);
    const wasWaiting = roomStatus === 'waiting';
    roomStatus = state.status;
    updateStateText();
    if (state.status === 'waiting' && !wasWaiting) {
      // 主持人按了「重新開始」：重新產生自己這份卡片、重置畫面
      bingoClaimed = false;
      if (role === 'player') { myCard = generateCard(); renderCard('playerBingoCard', myCard); }
      if (role === 'host' && hostAlsoPlays) { myCard = generateCard(); renderCard('hostBingoCard', myCard); }
      hideWinnerBanner();
    }
    if (role === 'host') {
      document.getElementById('btnStartGame').disabled = state.status !== 'waiting';
      document.getElementById('btnDrawNumber').disabled = state.status !== 'playing';
    }
    return;
  }

  if (suffix === 'calls') {
    if (!payload) return;
    const data = JSON.parse(payload);
    calledNumbers = data.numbers;
    const last = calledNumbers[calledNumbers.length - 1];
    document.getElementById('hostLastCalled') && (document.getElementById('hostLastCalled').textContent = last ? `${letterFor(last)}-${last}` : '尚未開始');
    document.getElementById('playerLastCalled') && (document.getElementById('playerLastCalled').textContent = last ? `${letterFor(last)}-${last}` : '尚未開始');
    document.getElementById('calledCount').textContent = calledNumbers.length;
    document.getElementById('calledCountP').textContent = calledNumbers.length;
    updateCalledBoard('calledBoard');
    updateCalledBoard('calledBoardP');
    autoDaub();
    return;
  }

  if (suffix === 'claim' && role === 'host') {
    const claim = JSON.parse(payload);
    handleClaim(claim);
    return;
  }

  if (suffix === 'winner') {
    if (!payload) { hideWinnerBanner(); return; }
    winnerInfo = JSON.parse(payload);
    showWinnerBanner(winnerInfo);
    return;
  }
}

function letterFor(num) {
  for (const letter of COLUMN_LETTERS) {
    const [min, max] = COLUMN_RANGES[letter];
    if (num >= min && num <= max) return letter;
  }
  return '?';
}

// ------------------------------------------------------------------
// 主持人：開始遊戲 / 抽號 / 裁定 BINGO / 重新開始
// ------------------------------------------------------------------

document.getElementById('btnStartGame').addEventListener('click', () => {
  calledNumbers = [];
  publishCalls();
  publishState('playing');
});

document.getElementById('btnDrawNumber').addEventListener('click', () => {
  if (calledNumbers.length >= 75) return;
  let n;
  do { n = Math.floor(Math.random() * 75) + 1; } while (calledNumbers.includes(n));
  calledNumbers.push(n);
  publishCalls();
  if (calledNumbers.length >= 75) publishState('ended');
});

document.getElementById('btnResetGame').addEventListener('click', () => {
  calledNumbers = [];
  clearWinner();
  publishCalls();
  publishState('waiting');
});

function handleClaim(claim) {
  if (winnerInfo) return; // 已經有優勝者了，忽略之後的宣告
  const allCalled = claim.numbers.every(n => calledNumbers.includes(n));
  if (!allCalled) {
    console.warn('收到無效的 BINGO 宣告（號碼尚未被叫到）', claim);
    return;
  }
  publishWinner({ id: claim.id, name: claim.name, pattern: claim.pattern, ts: Date.now() });
  publishState('ended');
}

// ------------------------------------------------------------------
// 玩家 / 主持人自己的卡片：自動劃記 + BINGO 宣告
// ------------------------------------------------------------------

function autoDaub() {
  if (myCard) {
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const val = myCard.grid[r][c];
        if (val !== 'FREE' && calledNumbers.includes(val)) myCard.marked[r][c] = true;
      }
    }
    const wrapId = role === 'host' ? 'hostBingoCard' : 'playerBingoCard';
    renderCard(wrapId, myCard);
    const btnId = role === 'host' ? 'btnHostBingo' : 'btnPlayerBingo';
    const btn = document.getElementById(btnId);
    if (btn) {
      const line = !bingoClaimed && !winnerInfo ? findCompletedLine(myCard) : null;
      btn.disabled = !line;
      btn.dataset.line = line ? JSON.stringify(line) : '';
    }
  }
}

function claimBingo() {
  const btnId = role === 'host' ? 'btnHostBingo' : 'btnPlayerBingo';
  const btn = document.getElementById(btnId);
  if (!btn.dataset.line) return;
  const line = JSON.parse(btn.dataset.line);
  const numbers = line.map(([r, c]) => myCard.grid[r][c]).filter(v => v !== 'FREE');
  bingoClaimed = true;
  btn.disabled = true;
  client.publish(topic('claim'), JSON.stringify({
    id: myId, name: myName, pattern: describeLine(line), numbers, ts: Date.now(),
  }), { qos: 1 });
}

document.getElementById('btnPlayerBingo').addEventListener('click', claimBingo);
document.getElementById('btnHostBingo').addEventListener('click', claimBingo);

// ------------------------------------------------------------------
// 畫面渲染
// ------------------------------------------------------------------

function updateStateText() {
  const label = { waiting: '等待主持人開始遊戲', playing: '遊戲進行中', ended: '遊戲結束' }[roomStatus] || roomStatus;
  const hostEl = document.getElementById('hostStateText');
  const playerEl = document.getElementById('playerStateText');
  if (hostEl) hostEl.textContent = label;
  if (playerEl) playerEl.textContent = label;
}

function renderPlayerList(list) {
  for (const ulId of ['playerList', 'playerListP']) {
    const ul = document.getElementById(ulId);
    if (!ul) continue;
    ul.innerHTML = '';
    for (const p of list) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="${p.role === 'host' ? 'role-host' : ''}">${p.name}${p.role === 'host' ? '（主持人）' : ''}</span>`;
      ul.appendChild(li);
    }
  }
}

function renderCard(elId, card) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '';
  COLUMN_LETTERS.forEach(letter => {
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = letter;
    el.appendChild(head);
  });
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const val = card.grid[r][c];
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (val === 'FREE') cell.classList.add('free');
      if (card.marked[r][c]) cell.classList.add('marked');
      cell.textContent = val === 'FREE' ? '★' : val;
      el.appendChild(cell);
    }
  }
}

function renderCalledBoard(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = '';
  for (let n = 1; n <= 75; n++) {
    const div = document.createElement('div');
    div.className = 'num';
    div.dataset.n = n;
    div.textContent = n;
    el.appendChild(div);
  }
}

function updateCalledBoard(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.querySelectorAll('.num').forEach(div => {
    div.classList.toggle('called', calledNumbers.includes(Number(div.dataset.n)));
  });
}

function showWinnerBanner(info) {
  const text = `🎉 ${info.name} 完成「${info.pattern}」，BINGO！遊戲結束。`;
  for (const id of ['hostWinnerBanner', 'playerWinnerBanner']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = text;
    el.classList.remove('hidden');
  }
}

function hideWinnerBanner() {
  for (const id of ['hostWinnerBanner', 'playerWinnerBanner']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.add('hidden');
    el.textContent = '';
  }
}

// ------------------------------------------------------------------
// 大廳畫面事件
// ------------------------------------------------------------------

document.getElementById('brokerHost').value = window.location.hostname !== '' ? window.location.hostname : '';
document.getElementById('roomCode').value = randomRoomCode();
document.getElementById('btnRandomRoom').addEventListener('click', () => {
  document.getElementById('roomCode').value = randomRoomCode();
});
document.getElementById('btnHost').addEventListener('click', () => connectAndEnterRoom('host'));
document.getElementById('btnJoin').addEventListener('click', () => connectAndEnterRoom('player'));
