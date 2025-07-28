/*********************************************************
 * L’Oréal Chatbot – script.js (Cloudflare Worker version)
 * - Tracks conversation context (name, past questions)
 * - Injects that context into every OpenAI call
 * - Typing bubble + fade-in friendly
 * - Clears input immediately & disables UI while sending
 * - Dark/Light mode toggle with persistence
 * - Auto logo invert in dark mode (via CSS)
 *********************************************************/

const WORKER_URL = "https://young-snow-985a.renaenweiss.workers.dev/"; // <-- your Worker URL

/* DOM elements */
const chatForm    = document.getElementById("chatForm");
const userInput   = document.getElementById("userInput");
const chatWindow  = document.getElementById("chatWindow");
const sendBtn     = document.getElementById("sendBtn");
const darkToggle  = document.getElementById("darkModeToggle");

/* Guard to avoid double-sends */
let isSending = false;

/* ---- 0) Lightweight “memory” for this session ---- */
let userContext = {
  name: null,
  pastQuestions: []
};

/* ---- 1) Base system prompt to keep the bot on-brand ---- */
const BASE_SYSTEM_PROMPT = `You are L’Oréal’s virtual product advisor.
- Answer only questions related to L’Oréal products, beauty routines, hair care, skincare, makeup, ingredients, and recommendations.
- If a user asks about unrelated topics, politely redirect them back to L’Oréal products and services.
- Be friendly, concise, professional and a little funny. Explain ingredients and routines clearly, avoid unverified medical claims.
- Encourage safe use (e.g., patch tests) and consulting a dermatologist if needed.`;

/**
 * The running transcript (excluding the dynamic context line).
 * We seed it with the single system prompt.
 */
let messages = [
  { role: "system", content: BASE_SYSTEM_PROMPT }
];

/* ---- 2) Greeting (visual only, not sent to the model) ---- */
appendMessage("ai", "👋 Hi! I’m your L’Oréal product advisor. Ask me about routines, ingredients, or which product fits your needs.");

/* ---- 2.1) Init theme ---- */
initTheme();

/* ---- 3) Form submit -> send to Cloudflare Worker ---- */
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isSending) return;

  const content = userInput.value.trim();
  if (!content) return;

  // Clear the input immediately + lock UI
  userInput.value = "";
  userInput.blur();
  userInput.disabled = true;
  sendBtn.disabled = true;
  isSending = true;

  // Show user's message
  appendMessage("user", content);
  messages.push({ role: "user", content });

  // Track context
  userContext.pastQuestions.push(content);
  detectAndStoreName(content);

  // Trim memory if it grows too long
  trimConversation();

  // Show typing bubble
  showTypingBubble();

  try {
    // Build messages with context, send to Worker
    const reply = await getOpenAIReply(buildMessagesWithContext());
    messages.push({ role: "assistant", content: reply });

    hideTypingBubble();
    appendMessage("ai", reply);
  } catch (err) {
    console.error("Worker/OpenAI error:", err);
    hideTypingBubble();
    appendMessage("ai", "⚠️ Sorry, I’m having trouble answering right now. Please try again.");
  } finally {
    // Re-enable UI
    userInput.disabled = false;
    sendBtn.disabled = false;
    userInput.focus();
    isSending = false;
  }
});

/* ---- 3.1) Dark/Light mode toggle ---- */
if (darkToggle) {
  darkToggle.addEventListener("click", () => {
    const nowDark = !document.body.classList.contains("dark-mode");
    document.body.classList.toggle("dark-mode", nowDark);
    localStorage.setItem("theme", nowDark ? "dark" : "light");
    syncToggleLabel(nowDark);
  });
}

function initTheme() {
  const saved = localStorage.getItem("theme");
  const wantsDark = saved === "dark";
  document.body.classList.toggle("dark-mode", wantsDark);
  syncToggleLabel(wantsDark);
}

function syncToggleLabel(isDark) {
  if (!darkToggle) return;
  darkToggle.textContent = isDark ? "Light Mode" : "Dark Mode";
  darkToggle.setAttribute("aria-pressed", String(isDark));
}

/* ---- 4) Helpers -------------------------------------------------- */

function appendMessage(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role === "user" ? "user" : "ai"}`;
  el.textContent = text;
  chatWindow.appendChild(el);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function showTypingBubble() {
  if (document.getElementById("typingBubble")) return;
  const bubble = document.createElement("div");
  bubble.className = "msg ai typing-bubble";
  bubble.id = "typingBubble";
  bubble.innerHTML = `
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
  `;
  chatWindow.appendChild(bubble);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function hideTypingBubble() {
  const bubble = document.getElementById("typingBubble");
  if (bubble) bubble.remove();
}

/**
 * Build a new messages array that prepends a dynamic context message
 * (user name + their past questions) before the running transcript.
 */
function buildMessagesWithContext() {
  let contextParts = [];
  if (userContext.name) {
    contextParts.push(`User's name: ${userContext.name}.`);
  }
  if (userContext.pastQuestions.length) {
    contextParts.push(`User previously asked about: ${userContext.pastQuestions.join("; ")}.`);
  }

  const contextBlock = contextParts.length
    ? `Conversation context: ${contextParts.join(" ")}`
    : "Conversation context: (none yet)";

  // messages[0] is always the base system prompt
  const baseSystem = messages[0];
  const convo = messages.slice(1);

  return [
    baseSystem,
    { role: "system", content: contextBlock },
    ...convo
  ];
}

/**
 * Basic name detector:
 * - "my name is X"
 * - "i am X" / "i’m X" / "im X"
 */
function detectAndStoreName(message) {
  if (userContext.name) return;

  const patterns = [
    /my name is\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,})/i,
    /\bi am\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,})/i,
    /\bi'm\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,})/i,
    /\bim\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,})/i
  ];

  for (const re of patterns) {
    const m = message.match(re);
    if (m && m[1]) {
      userContext.name = m[1].trim();
      break;
    }
  }
}

/**
 * Prevent the transcript from getting too long.
 */
function trimConversation(maxMessages = 40) {
  // Keep the first system message + the last N messages
  if (messages.length > maxMessages) {
    const system = messages[0];
    messages = [system, ...messages.slice(-maxMessages)];
  }

  // Optional: also cap pastQuestions length
  if (userContext.pastQuestions.length > 20) {
    userContext.pastQuestions = userContext.pastQuestions.slice(-10);
  }
}

/* ---- 5) Call your Cloudflare Worker (no API key in the browser) ---- */
async function getOpenAIReply(messagesWithContext) {
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: messagesWithContext })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }

  // If your Worker returns OpenAI's raw payload:
  if (data?.choices?.[0]?.message?.content) {
    return data.choices[0].message.content;
  }

  // Or if you decided to have the Worker return { reply: "..."}:
  if (data?.reply) return data.reply;

  throw new Error("Unexpected response shape from Worker");
}
