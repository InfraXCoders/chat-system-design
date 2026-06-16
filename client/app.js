const WS_URL =
  location.protocol === "file:"
    ? "ws://localhost:3001"
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

const API_BASE =
  location.protocol === "file:" ? "http://localhost:3001" : "";

// ── Avatar ─────────────────────────────────────────────────
const PALETTE = [
  "#e53935","#d81b60","#8e24aa","#5e35b1","#1e88e5",
  "#00897b","#43a047","#fb8c00","#6d4c41","#546e7a",
];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function setAvatar(el, name) {
  el.style.background = avatarColor(name);
  el.textContent = name.slice(0, 2).toUpperCase();
}

// ── DM room ID (must match server logic) ──────────────────
function dmRoomId(a, b) {
  return `dm:${[a, b].map(n => n.toLowerCase()).sort().join(":")}`;
}
function isDm(room) { return room.startsWith("dm:"); }
function dmLabel(room, me) {
  return room.slice(3).split(":").find(n => n !== me) ?? room;
}

// ── State ──────────────────────────────────────────────────
let socket        = null;
let myUsername    = "";
let myToken       = "";
let activeRoom    = null;

// Map<roomId, { type:"room"|"dm", label, unread, messages:[], presenceUsers:[] }>
const chats = new Map();

// ── DOM refs ───────────────────────────────────────────────
const joinOverlay   = document.getElementById("join-overlay");
const app           = document.getElementById("app");
const usernameInput = document.getElementById("username-input");
const roomInput     = document.getElementById("room-input");
const joinBtn       = document.getElementById("join-btn");
const myAvatar      = document.getElementById("my-avatar");
const myNameLabel   = document.getElementById("my-name-label");
const searchInput   = document.getElementById("search-input");
const chatList      = document.getElementById("chat-list");
const onlineList    = document.getElementById("online-list");
const emptyState    = document.getElementById("empty-state");
const activeChat    = document.getElementById("active-chat");
const chatAvatar    = document.getElementById("chat-avatar");
const chatName      = document.getElementById("chat-name");
const chatStatus    = document.getElementById("chat-status");
const messagesEl    = document.getElementById("messages");
const messageInput  = document.getElementById("message-input");
const sendBtn       = document.getElementById("send-btn");
const sendIcon      = document.getElementById("send-icon");
const micIcon       = document.getElementById("mic-icon");
const backBtn       = document.getElementById("back-btn");

// ── Join ───────────────────────────────────────────────────
joinBtn.addEventListener("click", startJoin);
[usernameInput, roomInput].forEach(el =>
  el.addEventListener("keydown", e => e.key === "Enter" && startJoin())
);

async function startJoin() {
  const username = usernameInput.value.trim();
  const room     = roomInput.value.trim().toLowerCase().replace(/\s+/g, "-");
  if (!username || !room) return;

  joinBtn.disabled = true;
  joinBtn.querySelector("span").textContent = "Connecting…";

  try {
    const res = await fetch(`${API_BASE}/auth`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ username }),
    });
    if (!res.ok) throw new Error(await res.text());
    myToken    = (await res.json()).token;
    myUsername = username;
  } catch (err) {
    joinBtn.disabled = false;
    joinBtn.querySelector("span").textContent = "Continue";
    alert(`Auth failed: ${err.message}`);
    return;
  }

  joinOverlay.classList.add("hidden");
  app.classList.remove("hidden");
  setAvatar(myAvatar, myUsername);
  myNameLabel.textContent = myUsername;

  connectWebSocket(room);
}

// ── WebSocket connection (one, shared across all rooms) ────
function connectWebSocket(initialRoom) {
  socket = new WebSocket(WS_URL);

  socket.addEventListener("open", () => {
    console.log("[ws] connected");
    setInterval(() => send({ type: "heartbeat" }), 15_000);
    // Join only after the socket is open — send() silently drops packets
    // if readyState isn't OPEN yet, which is always the case synchronously
    // after new WebSocket().
    if (initialRoom) joinRoom(initialRoom);
  });

  socket.addEventListener("message", e => {
    const pkt = JSON.parse(e.data);
    switch (pkt.type) {
      case "history":  handleHistory(pkt.room, pkt.payload);       break;
      case "message":  handleIncoming(pkt.payload);                break;
      case "presence": handlePresence(pkt.room, pkt.payload);      break;
      case "error":    appendSystem(activeRoom, `⚠ ${pkt.payload}`); break;
    }
  });

  socket.addEventListener("close", () => {
    if (activeRoom) appendSystem(activeRoom, "Disconnected. Refresh to reconnect.");
  });
}

function send(obj) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

// ── Room management ────────────────────────────────────────
function joinRoom(roomId) {
  if (!chats.has(roomId)) {
    chats.set(roomId, {
      type:     isDm(roomId) ? "dm" : "room",
      label:    isDm(roomId) ? dmLabel(roomId, myUsername) : `#${roomId}`,
      unread:   0,
      messages: [],
      presence: [],
    });
    renderChatListItem(roomId);
  }
  send({ type: "join", token: myToken, room: roomId });
  switchToChat(roomId);
}

function leaveRoom(roomId) {
  send({ type: "leave", room: roomId });
  chats.delete(roomId);
  removeChatListItem(roomId);
}

function switchToChat(roomId) {
  if (!chats.has(roomId)) return;
  activeRoom = roomId;

  // Mark active in sidebar
  document.querySelectorAll(".chat-item").forEach(el =>
    el.classList.toggle("active", el.dataset.room === roomId)
  );

  // Clear unread
  const chat = chats.get(roomId);
  chat.unread = 0;
  updateUnreadBadge(roomId);

  // Update header
  const isDirectMsg = isDm(roomId);
  setAvatar(chatAvatar, chat.label);
  chatName.textContent = chat.label;
  chatStatus.textContent = isDirectMsg ? "Direct message" : "Group room";

  // Re-render messages for this room
  messagesEl.innerHTML = "";
  lastDateStr = null;
  if (chat.messages.length === 0) {
    appendSystem(roomId, isDirectMsg
      ? `Start a conversation with ${chat.label}.`
      : "No messages yet — say hello! 👋"
    );
  } else {
    chat.messages.forEach(m => renderBubble(m, true));
  }

  // Update presence panel
  renderOnlineUsers(chat.presence);

  emptyState.classList.add("hidden");
  activeChat.classList.remove("hidden");

  // On mobile, slide the chat panel into view
  app.classList.add("chat-open");

  messageInput.focus();
}

// Back button — mobile only (CSS hides it on desktop)
backBtn.addEventListener("click", () => {
  app.classList.remove("chat-open");
});

// ── Open a DM with another user ────────────────────────────
function openDm(otherUser) {
  if (otherUser === myUsername) return;
  const roomId = dmRoomId(myUsername, otherUser);
  joinRoom(roomId);
}

// ── Incoming packet handlers ───────────────────────────────
function handleHistory(room, msgs) {
  const chat = chats.get(room);
  if (!chat) return;
  chat.messages = msgs;
  if (room === activeRoom) {
    messagesEl.innerHTML = "";
    lastDateStr = null;
    if (msgs.length === 0) {
      appendSystem(room, isDm(room)
        ? `Start a conversation with ${chat.label}.`
        : "No messages yet — say hello! 👋"
      );
    } else {
      msgs.forEach(m => renderBubble(m, true));
    }
  }
}

function handleIncoming(msg) {
  const chat = chats.get(msg.room);
  if (!chat) return;

  chat.messages.push(msg);
  updateChatPreview(msg.room, msg);

  if (msg.room === activeRoom) {
    renderBubble(msg, false);
  } else {
    // Unread badge — message arrived in a background chat
    chat.unread++;
    updateUnreadBadge(msg.room);
  }
}

function handlePresence(room, usernames) {
  const chat = chats.get(room);
  if (!chat) return;
  chat.presence = usernames;

  if (room === activeRoom) {
    renderOnlineUsers(usernames);
    const others = usernames.filter(n => n !== myUsername);
    if (isDm(room)) {
      chatStatus.textContent = others.length ? "online" : "offline";
    } else {
      chatStatus.textContent = others.length === 0
        ? "just you"
        : others.length <= 3
          ? `${others.join(", ")} online`
          : `${others.length} people online`;
    }
  }
}

// ── Render: online users panel ─────────────────────────────
function renderOnlineUsers(usernames) {
  onlineList.innerHTML = "";
  usernames.forEach(name => {
    const li = document.createElement("li");
    li.className = "online-item";
    li.dataset.user = name;

    const av = document.createElement("div");
    av.className = "avatar avatar-sm";
    setAvatar(av, name);

    const label = document.createElement("span");
    label.textContent = name + (name === myUsername ? " (you)" : "");

    li.appendChild(av);
    li.appendChild(label);

    if (name !== myUsername) {
      li.classList.add("clickable");
      li.title = `Message ${name}`;
      li.addEventListener("click", () => openDm(name));
    }
    onlineList.appendChild(li);
  });
}

// ── Render: sidebar chat list ──────────────────────────────
function renderChatListItem(roomId) {
  const chat = chats.get(roomId);
  const li   = document.createElement("li");
  li.className   = "chat-item";
  li.id          = `chat-item-${roomId}`;
  li.dataset.room = roomId;

  const av = document.createElement("div");
  av.className = isDm(roomId) ? "avatar avatar-dm" : "avatar avatar-room";
  setAvatar(av, chat.label);

  const info = document.createElement("div");
  info.className = "chat-item-info";
  info.innerHTML = `
    <div class="chat-item-top">
      <span class="chat-item-name">${chat.label}</span>
      <span class="chat-item-time"></span>
    </div>
    <div class="chat-item-bottom">
      <span class="chat-item-preview"></span>
      <span class="unread-badge hidden"></span>
    </div>
  `;

  li.appendChild(av);
  li.appendChild(info);
  li.addEventListener("click", () => switchToChat(roomId));
  chatList.prepend(li);
}

function removeChatListItem(roomId) {
  document.getElementById(`chat-item-${roomId}`)?.remove();
}

function updateChatPreview(roomId, msg) {
  const item = document.getElementById(`chat-item-${roomId}`);
  if (!item) return;
  const preview = msg.username === myUsername
    ? `You: ${msg.content}`
    : isDm(roomId) ? msg.content : `${msg.username}: ${msg.content}`;
  item.querySelector(".chat-item-preview").textContent = truncate(preview, 36);
  item.querySelector(".chat-item-time").textContent = formatTime(new Date(msg.created_at));
  // Bubble item to top
  chatList.prepend(item);
}

function updateUnreadBadge(roomId) {
  const item  = document.getElementById(`chat-item-${roomId}`);
  if (!item) return;
  const badge = item.querySelector(".unread-badge");
  const count = chats.get(roomId)?.unread ?? 0;
  badge.textContent = count > 99 ? "99+" : count;
  badge.classList.toggle("hidden", count === 0);
}

// ── Render: message bubbles ────────────────────────────────
let lastDateStr = null;

function renderBubble(msg, isHistory) {
  const date    = new Date(msg.created_at);
  const dateStr = date.toLocaleDateString(undefined, { weekday:"long", month:"short", day:"numeric" });

  if (dateStr !== lastDateStr) {
    lastDateStr = dateStr;
    const chip = document.createElement("div");
    chip.className = "date-chip";
    chip.textContent = isToday(date) ? "Today" : isYesterday(date) ? "Yesterday" : dateStr;
    messagesEl.appendChild(chip);
  }

  const isOut = msg.username === myUsername;
  const row   = document.createElement("div");
  row.className = `msg-row ${isOut ? "out" : "in"}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (!isOut && !isDm(msg.room)) {
    const sender = document.createElement("div");
    sender.className = "bubble-sender";
    sender.style.color = avatarColor(msg.username);
    sender.textContent = msg.username;
    bubble.appendChild(sender);
  }

  const text = document.createElement("div");
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
    ticks.innerHTML = `<svg viewBox="0 0 16 11" fill="none" width="16" height="16"><path d="M1 5.5l4 4L14 1" stroke="#8696a0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    footer.appendChild(ticks);
  }
  bubble.appendChild(footer);
  row.appendChild(bubble);
  messagesEl.appendChild(row);

  if (!isHistory) scrollToBottom();
}

function appendSystem(room, text) {
  if (room !== activeRoom) return;
  const el = document.createElement("div");
  el.className = "sys-msg";
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

// ── Send message ───────────────────────────────────────────
messageInput.addEventListener("input", () => {
  const has = messageInput.value.trim().length > 0;
  sendIcon.classList.toggle("hidden", !has);
  micIcon.classList.toggle("hidden", has);
});
micIcon.classList.remove("hidden");
sendIcon.classList.add("hidden");

sendBtn.addEventListener("click", doSend);
messageInput.addEventListener("keydown", e => e.key === "Enter" && !e.shiftKey && doSend());

function doSend() {
  const content = messageInput.value.trim();
  if (!content || !activeRoom) return;
  send({ type: "message", room: activeRoom, content });
  messageInput.value = "";
  sendIcon.classList.add("hidden");
  micIcon.classList.remove("hidden");
}

// ── Search ─────────────────────────────────────────────────
searchInput.addEventListener("input", () => {
  const q = searchInput.value.toLowerCase();
  document.querySelectorAll(".chat-item").forEach(el => {
    el.style.display = el.dataset.room.toLowerCase().includes(q) ? "" : "none";
  });
});

// ── Helpers ────────────────────────────────────────────────
function scrollToBottom() {
  requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
}
function formatTime(date) {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function isToday(d) { return d.toDateString() === new Date().toDateString(); }
function isYesterday(d) {
  const y = new Date(); y.setDate(y.getDate() - 1);
  return d.toDateString() === y.toDateString();
}
function truncate(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }
