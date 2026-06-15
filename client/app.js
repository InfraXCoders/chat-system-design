// Derive the WebSocket URL from the page's own location.
// Served over http://<vps-ip>  → ws://<vps-ip>
// Served over https://<domain> → wss://<domain>  (automatic when you add TLS)
// Falls back to localhost:3001 when the file is opened directly from disk.
const WS_URL =
  location.protocol === "file:"
    ? "ws://localhost:3001"
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

// Avatar palette — consistent colour per username
const PALETTE = [
  "#e53935","#d81b60","#8e24aa","#5e35b1","#1e88e5",
  "#00897b","#43a047","#fb8c00","#6d4c41","#546e7a",
];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initials(name) {
  return name.slice(0, 2).toUpperCase();
}
function setAvatar(el, name) {
  el.style.background = avatarColor(name);
  el.textContent = initials(name);
}

// ── State ──────────────────────────────────────────────────
let socket = null;
let myUsername = "";
let myRoom = "";
let heartbeatInterval = null;
let onlineUsers = [];

// ── DOM ────────────────────────────────────────────────────
const joinOverlay   = document.getElementById("join-overlay");
const app           = document.getElementById("app");
const usernameInput = document.getElementById("username-input");
const roomInput     = document.getElementById("room-input");
const joinBtn       = document.getElementById("join-btn");
const myAvatar      = document.getElementById("my-avatar");
const myNameLabel   = document.getElementById("my-name-label");
const searchInput   = document.getElementById("search-input");
const chatList      = document.getElementById("chat-list");
const emptyState    = document.getElementById("empty-state");
const activeChat    = document.getElementById("active-chat");
const chatAvatar    = document.getElementById("chat-avatar");
const chatName      = document.getElementById("chat-name");
const chatStatus    = document.getElementById("chat-status");
const messages      = document.getElementById("messages");
const messageInput  = document.getElementById("message-input");
const sendBtn       = document.getElementById("send-btn");
const sendIcon      = document.getElementById("send-icon");
const micIcon       = document.getElementById("mic-icon");

// ── Join ───────────────────────────────────────────────────
joinBtn.addEventListener("click", startJoin);
[usernameInput, roomInput].forEach(el =>
  el.addEventListener("keydown", e => e.key === "Enter" && startJoin())
);

function startJoin() {
  const username = usernameInput.value.trim();
  const room     = roomInput.value.trim().toLowerCase().replace(/\s+/g, "-");
  if (!username || !room) return;

  myUsername = username;
  myRoom     = room;

  // Show app shell immediately
  joinOverlay.classList.add("hidden");
  app.classList.remove("hidden");

  // Populate sidebar header
  setAvatar(myAvatar, myUsername);
  myNameLabel.textContent = myUsername;

  // Add this room to the chat list and mark active
  upsertChatItem(room);
  activateChatItem(room);

  // Connect WebSocket
  connect(room, username);
}

// ── Chat list ──────────────────────────────────────────────
function upsertChatItem(room, preview = "", time = "") {
  if (document.getElementById(`chat-item-${room}`)) return;

  const li = document.createElement("li");
  li.className = "chat-item";
  li.id = `chat-item-${room}`;
  li.dataset.room = room;

  const av = document.createElement("div");
  av.className = "avatar";
  setAvatar(av, room);

  const info = document.createElement("div");
  info.className = "chat-item-info";
  info.innerHTML = `
    <div class="chat-item-top">
      <span class="chat-item-name">#${room}</span>
      <span class="chat-item-time">${time}</span>
    </div>
    <div class="chat-item-preview">${preview}</div>
  `;

  li.appendChild(av);
  li.appendChild(info);
  chatList.prepend(li);
}

function activateChatItem(room) {
  document.querySelectorAll(".chat-item").forEach(el => el.classList.remove("active"));
  const item = document.getElementById(`chat-item-${room}`);
  if (item) item.classList.add("active");

  // Show active chat panel
  emptyState.classList.add("hidden");
  activeChat.classList.remove("hidden");

  // Update header
  setAvatar(chatAvatar, room);
  chatName.textContent = `#${room}`;
  chatStatus.textContent = "connecting…";
}

function updateChatItemPreview(room, text, time) {
  const item = document.getElementById(`chat-item-${room}`);
  if (!item) return;
  item.querySelector(".chat-item-preview").textContent = text;
  item.querySelector(".chat-item-time").textContent = time;
}

// ── WebSocket ──────────────────────────────────────────────
function connect(room, username) {
  socket = new WebSocket(WS_URL);

  socket.addEventListener("open", () => {
    send({ type: "join", room, username });
    heartbeatInterval = setInterval(() => send({ type: "heartbeat" }), 15_000);
    chatStatus.textContent = "connected";
  });

  socket.addEventListener("message", e => {
    const pkt = JSON.parse(e.data);
    if (pkt.type === "history")  renderHistory(pkt.payload);
    if (pkt.type === "message")  renderMessage(pkt.payload, false);
    if (pkt.type === "presence") renderPresence(pkt.payload);
  });

  socket.addEventListener("close", () => {
    clearInterval(heartbeatInterval);
    chatStatus.textContent = "disconnected";
    appendSystem("Connection lost. Refresh to reconnect.");
  });

  socket.addEventListener("error", () => {
    appendSystem("Cannot reach server — is it running?");
  });
}

function send(obj) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

// ── Send message ───────────────────────────────────────────
messageInput.addEventListener("input", () => {
  const hasText = messageInput.value.trim().length > 0;
  sendIcon.classList.toggle("hidden", !hasText);
  micIcon.classList.toggle("hidden", hasText);
});

// Start with mic showing
micIcon.classList.remove("hidden");
sendIcon.classList.add("hidden");

sendBtn.addEventListener("click", doSend);
messageInput.addEventListener("keydown", e => e.key === "Enter" && !e.shiftKey && doSend());

function doSend() {
  const content = messageInput.value.trim();
  if (!content) return;
  send({ type: "message", content });
  messageInput.value = "";
  sendIcon.classList.add("hidden");
  micIcon.classList.remove("hidden");
}

// ── Presence ───────────────────────────────────────────────
function renderPresence(usernames) {
  onlineUsers = usernames;
  const others = usernames.filter(n => n !== myUsername);
  if (others.length === 0) {
    chatStatus.textContent = "just you";
  } else if (others.length <= 3) {
    chatStatus.textContent = `${others.join(", ")} online`;
  } else {
    chatStatus.textContent = `${others.length} people online`;
  }
}

// ── Render messages ────────────────────────────────────────
let lastDateStr = null;

function renderHistory(msgs) {
  messages.innerHTML = "";
  lastDateStr = null;
  if (msgs.length === 0) {
    appendSystem("No messages yet — say hello! 👋");
    return;
  }
  msgs.forEach(m => renderMessage(m, true));
}

function renderMessage(msg, isHistory) {
  const date = new Date(msg.created_at);
  const dateStr = date.toLocaleDateString(undefined, { weekday:"long", month:"short", day:"numeric" });

  if (dateStr !== lastDateStr) {
    lastDateStr = dateStr;
    const chip = document.createElement("div");
    chip.className = "date-chip";
    chip.textContent = isToday(date) ? "Today" : isYesterday(date) ? "Yesterday" : dateStr;
    messages.appendChild(chip);
  }

  const isOut = msg.username === myUsername;

  const row = document.createElement("div");
  row.className = `msg-row ${isOut ? "out" : "in"}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (!isOut) {
    const sender = document.createElement("div");
    sender.className = "bubble-sender";
    sender.style.color = avatarColor(msg.username);
    sender.textContent = msg.username;
    bubble.appendChild(sender);
  }

  const text = document.createElement("div");
  text.className = "bubble-text";
  text.textContent = msg.content;
  bubble.appendChild(text);

  const footer = document.createElement("div");
  footer.className = "bubble-footer";
  const timeEl = document.createElement("span");
  timeEl.className = "bubble-time";
  timeEl.textContent = formatTime(date);
  footer.appendChild(timeEl);

  if (isOut) {
    const ticks = document.createElement("span");
    ticks.className = "ticks";
    ticks.innerHTML = `<svg viewBox="0 0 16 11" fill="none"><path d="M1 5.5l4 4L14 1" stroke="#8696a0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    footer.appendChild(ticks);
  }

  bubble.appendChild(footer);
  row.appendChild(bubble);
  messages.appendChild(row);

  // Update sidebar preview
  const preview = isOut ? `You: ${msg.content}` : `${msg.username}: ${msg.content}`;
  updateChatItemPreview(myRoom, truncate(preview, 38), formatTime(date));

  if (!isHistory) scrollToBottom();
}

function appendSystem(text) {
  const el = document.createElement("div");
  el.className = "sys-msg";
  el.textContent = text;
  messages.appendChild(el);
  scrollToBottom();
}

// ── Helpers ────────────────────────────────────────────────
function scrollToBottom() {
  requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
}

function formatTime(date) {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function isToday(date) {
  const now = new Date();
  return date.toDateString() === now.toDateString();
}

function isYesterday(date) {
  const y = new Date(); y.setDate(y.getDate() - 1);
  return date.toDateString() === y.toDateString();
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + "…" : str;
}

// ── Search filter ──────────────────────────────────────────
searchInput.addEventListener("input", () => {
  const q = searchInput.value.toLowerCase();
  document.querySelectorAll(".chat-item").forEach(el => {
    const name = el.dataset.room.toLowerCase();
    el.style.display = name.includes(q) ? "" : "none";
  });
});
