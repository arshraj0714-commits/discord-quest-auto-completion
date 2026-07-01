const WebSocket = require('ws');

const API_BASE = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=9&encoding=json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── REST API ───────────────────────────────────────────────

function getHeaders(token) {
  return {
    Authorization: token,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    'X-Discord-Client-Build': '235735', // Required for quests API
    'X-Discord-Locale': 'en-US',
  };
}

async function fetchQuests(token) {
  const res = await fetch(`${API_BASE}/users/@me/quests`, {
    headers: getHeaders(token),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Fetch quests failed: ${res.status} ${res.statusText} ${text}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : data.quests || [];
}

async function fetchQuest(token, questId) {
  const res = await fetch(`${API_BASE}/users/@me/quests/${questId}`, {
    headers: getHeaders(token),
  });
  if (!res.ok) throw new Error(`Fetch quest failed: ${res.status}`);
  return res.json();
}

async function ackQuest(token, questId) {
  try {
    await fetch(`${API_BASE}/users/@me/quests/${questId}/ack`, {
      method: 'POST',
      headers: getHeaders(token),
    });
  } catch {
    /* ignore ack errors */
  }
}

async function validateToken(token) {
  try {
    const res = await fetch(`${API_BASE}/users/@me`, {
      headers: getHeaders(token),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── Quest Helpers ──────────────────────────────────────────

function isQuestCompleted(quest) {
  if (!quest) return false;
  if (quest.status === 'COMPLETED') return true;
  if (quest.user_status?.completed) return true;
  if (quest.completed) return true;
  if (quest.status?.completed) return true;
  return false;
}

function getQuestProgress(quest) {
  if (quest.user_status?.progress !== undefined) return quest.user_status.progress;
  if (quest.status?.progress !== undefined) return quest.status.progress;
  if (quest.progress !== undefined) return quest.progress;
  return 0;
}

function getQuestDuration(quest) {
  const config = quest.config || {};
  const taskConfig = config.task_config || {};
  if (taskConfig.duration_seconds) return taskConfig.duration_seconds * 1000;
  if (taskConfig.duration_ms) return taskConfig.duration_ms;
  if (config.duration_seconds) return config.duration_seconds * 1000;
  if (config.duration_ms) return config.duration_ms;
  return 15 * 60 * 1000; // default 15 min
}

function createActivityForQuest(quest) {
  const config = quest.config || {};
  const taskConfig = config.task_config || {};
  const taskType = (config.task_type || taskConfig.task_type || '').toUpperCase();

  // Streaming quest — need a Twitch URL
  if (
    taskType.includes('STREAM') ||
    taskType.includes('WATCH') ||
    taskConfig.stream_url ||
    taskConfig.preferred_stream_type
  ) {
    return {
      type: 1, // STREAMING
      url: taskConfig.stream_url || 'https://www.twitch.tv/twitch',
      name: 'Twitch',
      details: 'Completing Discord Quest',
      timestamps: { start: Date.now() },
    };
  }

  // Game quest — need application_id
  if (
    taskType.includes('GAME') ||
    taskType.includes('PLAY') ||
    taskConfig.application_id ||
    config.application_id
  ) {
    return {
      type: 0, // PLAYING
      name: taskConfig.name || config.name || 'Discord Quest',
      application_id: taskConfig.application_id || config.application_id,
      timestamps: { start: Date.now() },
    };
  }

  // Fallback generic activity
  return {
    type: 0,
    name: quest.name || 'Discord Quest',
    timestamps: { start: Date.now() },
  };
}

// ─── Gateway Connection ─────────────────────────────────────

class GatewayConnection {
  constructor(token) {
    this.token = token;
    this.ws = null;
    this.heartbeatTimer = null;
    this.sequence = null;
    this.sessionId = null;
    this.ready = false;
  }

  connect(activities = []) {
    return new Promise((resolve, reject) => {
      this._activities = activities;

      const timeout = setTimeout(() => {
        this.disconnect();
        reject(new Error('Gateway connection timeout'));
      }, 30_000);

      this._timeout = timeout;
      this._resolve = resolve;
      this._reject = reject;

      this.ws = new WebSocket(GATEWAY_URL);

      this.ws.on('open', () => console.log('[Gateway] Connected'));

      this.ws.on('message', (raw) => {
        try {
          this._handleMessage(JSON.parse(raw.toString()));
        } catch (e) {
          console.error('[Gateway] Parse error:', e.message);
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        if (!this.ready) reject(err);
      });

      this.ws.on('close', (code) => {
        console.log(`[Gateway] Closed: ${code}`);
        this._cleanup();
      });
    });
  }

  _handleMessage(payload) {
    const { op, t, d, s } = payload;
    if (s) this.sequence = s;

    switch (op) {
      case 10: // HELLO
        this._startHeartbeat(d.heartbeat_interval);
        this._identify();
        break;

      case 0: // DISPATCH
        if (t === 'READY') {
          this.sessionId = d.session_id;
          this.ready = true;
          clearTimeout(this._timeout);
          console.log(`[Gateway] Ready as ${d.user?.username || 'unknown'}`);
          this._resolve(d);
        }
        break;

      case 11: // HEARTBEAT ACK
        break;

      case 1: // HEARTBEAT request
        this._sendHeartbeat();
        break;
    }
  }

  _startHeartbeat(interval) {
    this.heartbeatTimer = setInterval(() => this._sendHeartbeat(), interval);
  }

  _sendHeartbeat() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op: 1, d: this.sequence }));
    }
  }

  _identify() {
    this.ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: this.token,
          intents: 0,
          properties: {
            os: 'Windows',
            browser: 'Discord Client',
            device: 'Discord Client',
          },
          presence: {
            activities: this._activities,
            status: 'online',
            since: 0,
            afk: false,
          },
        },
      })
    );
  }

  updatePresence(activities) {
    this._activities = activities;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          op: 3,
          d: { activities, status: 'online', since: 0, afk: false },
        })
      );
    }
  }

  _cleanup() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ready = false;
  }

  disconnect() {
    this._cleanup();
    if (this._timeout) clearTimeout(this._timeout);
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000);
      this.ws = null;
    }
  }
}

// ─── Quest Completion ───────────────────────────────────────

async function completeQuest(token, quest, onProgress = null) {
  if (isQuestCompleted(quest)) {
    return { success: true, quest, reason: 'Already completed' };
  }

  // Ack the quest
  await ackQuest(token, quest.id);

  // Build activity
  const activity = createActivityForQuest(quest);
  console.log(
    `[Quest] Starting: ${quest.name || quest.id} | type=${activity.type} | app=${activity.application_id || 'stream'}`
  );

  // Connect to gateway
  const conn = new GatewayConnection(token);
  try {
    await conn.connect([activity]);
  } catch (error) {
    return { success: false, quest, reason: `Gateway: ${error.message}` };
  }

  // Poll for completion
  const duration = getQuestDuration(quest);
  const maxWait = duration + 120_000; // 2 min buffer
  const startTime = Date.now();

  while (Date.now() - startTime < maxWait) {
    await sleep(30_000);
    const elapsed = Date.now() - startTime;

    try {
      const updated = await fetchQuest(token, quest.id);

      if (onProgress) {
        onProgress({
          elapsed,
          duration,
          progress: getQuestProgress(updated),
          completed: isQuestCompleted(updated),
        });
      }

      if (isQuestCompleted(updated)) {
        conn.disconnect();
        return { success: true, quest: updated, reason: 'Completed' };
      }
    } catch (error) {
      console.error('[Quest] Status check error:', error.message);
    }
  }

  conn.disconnect();
  return { success: false, quest, reason: 'Timeout' };
}

async function completeAllQuests(token, onProgress = null) {
  const quests = await fetchQuests(token);
  const incomplete = quests.filter((q) => !isQuestCompleted(q));
  const results = [];

  for (let i = 0; i < incomplete.length; i++) {
    const quest = incomplete[i];
    if (onProgress) onProgress({ current: i + 1, total: incomplete.length, quest });

    const result = await completeQuest(token, quest);
    results.push(result);
  }

  return {
    results,
    total: incomplete.length,
    completed: results.filter((r) => r.success).length,
  };
}

module.exports = {
  fetchQuests,
  fetchQuest,
  completeQuest,
  completeAllQuests,
  validateToken,
  isQuestCompleted,
  getQuestProgress,
};
