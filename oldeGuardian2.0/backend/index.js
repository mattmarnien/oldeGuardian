require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const SpotifyWebApi = require('spotify-web-api-node');
const { joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, VoiceConnectionStatus, entersState, NoSubscriberBehavior } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
// guard: true once we've finished loading persistedState from disk
let stateLoaded = false;

// minimal top-level runtime state declarations (ensure these exist)
const PORT = process.env.BACKEND_PORT || 3001;
const app = express();
// parse JSON and urlencoded request bodies
// capture raw request bodies for debugging (do not modify the body passed to downstream parsers)
app.use(express.json({
  verify: (req, res, buf, encoding) => {
    try {
      const s = buf && buf.toString(encoding || 'utf8');
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [raw-body] ${req.method} ${req.originalUrl || req.url} -> ${s}\n`); } catch (e) {}
    } catch (e) {}
  }
}));
app.use(express.urlencoded({ extended: true }));

// path to persisted state file
const STATE_PATH = path.join(__dirname, 'state.json');

// in-memory persisted state (will be populated by loadStateFromDisk)
let persistedState = { connections: {}, nowPlaying: {} };

// common runtime maps/sets used by the server
const players = new Map();
const connections = new Map();
const ffmpegProcs = new Map();
const sseClients = []; // { id, res, guildId }
const loopFlags = new Map();

// simple SSE broadcast helper
function broadcastSse(guildId, data) {
  try {
    const payload = `data: ${JSON.stringify(Object.assign({ guildId }, data))}\n\n`;
    for (const c of Array.from(sseClients)) {
      try {
        if (c.guildId && guildId && c.guildId !== guildId) continue;
        c.res.write(payload);
      } catch (e) {
        // ignore write errors; client may have disconnected
      }
    }
  } catch (e) {}
}

// create a minimal Discord client instance (used elsewhere)
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });


function loadStateFromDisk() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const raw = fs.readFileSync(STATE_PATH, 'utf8');
      const obj = JSON.parse(raw || '{}');
      if (obj && typeof obj === 'object') {
        persistedState = Object.assign({ connections: {}, nowPlaying: {} }, obj);
      }
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [state] loaded from disk ${STATE_PATH}\n`); } catch(e){}
    }
  } catch (e) {
    console.error('[state] load failed', e && e.message);
  }
  // mark that persistedState has been initialized (even if file did not exist)
  try { stateLoaded = true; } catch(e) {}
}

function saveStateToDisk() {
  try {
    // avoid writing out a default/empty state before the initial load completes
    if (!stateLoaded) {
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [state] save skipped until initial load completed\n`); } catch(e){}
      return;
    }
    const tmp = STATE_PATH + '.tmp';
    const body = JSON.stringify(persistedState, null, 2);
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, STATE_PATH);
    // write a human-readable debug copy for diagnostics to a fixed path
    try {
      const dbgPath = path.join(__dirname, 'state.debug.json');
      fs.writeFileSync(dbgPath, body, 'utf8');
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [state] debug written to ${dbgPath}\n`); } catch (e) {}
    } catch (e) {
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [state] debug write failed ${e && (e.stack || e.message)}\n`); } catch (ee) {}
    }
    // always append a compact base64-encoded copy of the JSON to backend logs so logs contain exact payload
    try {
      const b64 = Buffer.from(body || '', 'utf8').toString('base64');
      const globalLogPath = path.join(__dirname, '..', '..', 'backend.log');
      const localLogPath = path.join(__dirname, 'backend.log');
      try { require('fs').appendFileSync(globalLogPath, `[${new Date().toISOString()}] [state] debug-json base64:${b64}\n`); } catch (e) {}
      try { require('fs').appendFileSync(localLogPath, `[${new Date().toISOString()}] [state] debug-json base64:${b64}\n`); } catch (e) {}
    } catch (e) {}
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [state] saved to disk ${STATE_PATH}\n`); } catch(e){}
  } catch (e) {
    console.error('[state] save failed', e && e.message);
  }
}

// Load persisted state at startup
loadStateFromDisk();

// Attempt to get duration (seconds) for a media file by running ffmpeg probe and parsing stderr
function getDurationSeconds(filePath) {
  try {
    // run ffmpeg -i <file> and parse stderr for Duration: HH:MM:SS.xx
    const spawnSync = require('child_process').spawnSync;
    const out = spawnSync(ffmpegPath, ['-i', filePath], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
    const stderr = out.stderr || '';
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      const ss = Number(m[3]);
      return hh * 3600 + mm * 60 + ss;
    }
  } catch (e) {
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [getDuration] error ${e.stack || e}\n`); } catch (ee) {}
  }
  return null;
}

// Load persisted volumes at startup
// per-guild volume maps (in-memory)
const VOLUMES_PATH = path.join(__dirname, 'volumes.json');
const musicVolumes = new Map();
const sfxVolumes = new Map();

function loadVolumesFromDisk() {
  try {
    if (fs.existsSync(VOLUMES_PATH)) {
      const raw = fs.readFileSync(VOLUMES_PATH, 'utf8');
      const obj = JSON.parse(raw || '{}');
      if (obj && typeof obj === 'object') {
        const m = obj.music || obj.musicVolumes || {};
        const s = obj.sfx || obj.soundEffects || obj.sfxVolumes || {};
        for (const [k, v] of Object.entries(m)) {
          try { musicVolumes.set(String(k), Number(v)); } catch (e) { musicVolumes.set(String(k), v); }
        }
        for (const [k, v] of Object.entries(s)) {
          try { sfxVolumes.set(String(k), Number(v)); } catch (e) { sfxVolumes.set(String(k), v); }
        }
      }
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [volumes] loaded from disk ${VOLUMES_PATH}\n`); } catch(e){}
    }
  } catch (e) {
    console.error('[volumes] load failed', e && e.message);
  }
}

function saveVolumesToDisk() {
  try {
    const obj = { music: {}, sfx: {} };
    for (const [k, v] of musicVolumes.entries()) obj.music[k] = v;
    for (const [k, v] of sfxVolumes.entries()) obj.sfx[k] = v;
    const tmp = VOLUMES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, VOLUMES_PATH);
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [volumes] saved to disk ${VOLUMES_PATH}\n`); } catch(e){}
  } catch (e) {
    console.error('[volumes] save failed', e && e.message);
  }
}

// load persisted volumes now
loadVolumesFromDisk();

// Create or return a per-guild AudioPlayer with logging
function getPlayerForGuild(guildId) {
  if (players.has(guildId)) return players.get(guildId);
  const p = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  try {
    p.on('stateChange', (oldState, newState) => {
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [player:${guildId}] state ${oldState.status} -> ${newState.status}\n`); } catch (e) {}
    });
    // surface player errors to the log to avoid uncaught exceptions bubbling
    p.on('error', (err) => {
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [player:${guildId}] error ${err && (err.stack || err.message)}\n`); } catch (e) {}
      console.error('[player] error', err && (err.stack || err.message));
    });
  } catch (e) {}
  players.set(guildId, p);
  return p;
}

// Server-Sent Events endpoint for real-time updates
app.get('/api/events', (req, res) => {
  const guildId = req.query.guildId || null;
  // set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  const clientId = Date.now() + Math.random();
  const client = { id: clientId, res, guildId };
  sseClients.push(client);
  // send initial status
  try {
    const initial = { type: 'status', guildId, playing: !!(guildId && players.has(guildId) && players.get(guildId).state && players.get(guildId).state.status === AudioPlayerStatus.Playing), loop: !!loopFlags.get(guildId) };
    // include persisted nowPlaying info for this guild if available
    try {
      const np = persistedState.nowPlaying && persistedState.nowPlaying[guildId];
      if (np) initial.nowPlaying = np;
    } catch (e) {}
    res.write(`data: ${JSON.stringify(initial)}\n\n`);
  } catch (e) {}
  req.on('close', () => {
    const idx = sseClients.findIndex(c => c.id === clientId);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// Player control endpoint: actions = pause|resume|stop|toggleLoop
app.post('/api/player', async (req, res) => {
  // TEMP TELEMETRY: log headers + raw body for debugging malformed requests from browser/dev-proxy
  try {
    const headerSnapshot = JSON.stringify(req.headers || {});
    let rawBody = null;
    try { rawBody = JSON.stringify(req.body); } catch (e) { rawBody = String(req.body); }
    require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [api/player] headers: ${headerSnapshot}\n`);
    require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [api/player] body: ${rawBody}\n`);
  } catch (e) {
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [api/player] telemetry error: ${e && (e.stack || e.message)}\n`); } catch (ee) {}
  }
  const { guildId, action } = req.body || {};
  if (!guildId || !action) return res.status(400).json({ error: 'guildId and action are required' });
  let player = players.get(guildId);
  try {
    if (action === 'pause') {
      // persist paused state and current position
      try {
        const entry = persistedState.nowPlaying && persistedState.nowPlaying[guildId];
        const pos = entry && typeof entry.position === 'number' ? entry.position : 0;
        if (!persistedState.nowPlaying) persistedState.nowPlaying = {};
        persistedState.nowPlaying[guildId] = Object.assign({}, entry || {}, { position: pos, paused: true, updated: new Date().toISOString() });
        saveStateToDisk();
      } catch (e) {}
      // attempt to stop the player (so ffmpeg is killed). We'll rely on persisted position to resume.
      if (!player) return res.status(404).json({ error: 'No player for guild' });
      try { player.stop(true); } catch (e) { try { player.stop(); } catch (ee) {} }
      try { broadcastSse(guildId, { type: 'state', playing: false }); } catch (e) {}
      return res.json({ success: true, action: 'pause' });
    }
    if (action === 'resume' || action === 'play') {
      // read persisted position and restart playback at that offset
      try {
        const entry = persistedState.nowPlaying && persistedState.nowPlaying[guildId];
        const startPos = entry && typeof entry.position === 'number' ? entry.position : 0;
        // get stored channelId if available
        const rec = persistedState.connections && persistedState.connections[guildId];
        const channelId = rec && rec.channelId;
        if (!channelId) return res.status(400).json({ error: 'No persisted channel for guild; cannot resume' });
        // ensure we have a player instance available
        try { if (!player) player = getPlayerForGuild(guildId); } catch (e) {}
        // stop existing player if any to ensure fresh subscription
        try { if (player) { try { player.stop(true); } catch (e) { try { player.stop(); } catch (ee) {} } } } catch (e) {}
        // invoke playTrack to start from startPos and WAIT for result so caller knows if resume succeeded
        const track = entry && entry.track;
        if (!track) return res.status(400).json({ error: 'No persisted track to resume' });
        try {
          const result = await playTrack({ guildId, channel: channelId, track, startPosition: startPos });
          // clear paused flag on success
          try { if (persistedState.nowPlaying && persistedState.nowPlaying[guildId]) { persistedState.nowPlaying[guildId].paused = false; persistedState.nowPlaying[guildId].updated = new Date().toISOString(); saveStateToDisk(); } } catch (e) {}
          return res.json(Object.assign({ action: 'resume' }, result));
        } catch (e) {
          console.error('[resume] playTrack failed', e && (e.stack || e.message));
          try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [resume] playTrack failed ${e && (e.stack || e.message)}\n`); } catch (ee) {}
          return res.status(500).json({ error: 'resume failed', details: String(e && (e.stack || e.message)) });
        }
      } catch (e) {
        return res.status(500).json({ error: String(e && e.message) });
      }
    }
    if (action === 'stop') {
      try { player.stop(true); } catch (e) { try { player.stop(); } catch (ee) {} }
      return res.json({ success: true, action: 'stop' });
    }
    if (action === 'toggleLoop') {
      const current = !!loopFlags.get(guildId);
      loopFlags.set(guildId, !current);
      try { broadcastSse(guildId, { type: 'loop', loop: !current }); } catch (e) {}
      return res.json({ success: true, loop: !current });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error('[api/player] error', err);
    return res.status(500).json({ error: String(err && err.message) });
  }
});

// Disconnect bot from all guild voice channels and stop all players
app.post('/api/disconnect-all', (req, res) => {
  try {
    const disconnected = [];
    // stop all players
    for (const [gid, player] of players.entries()) {
      try { player.stop(true); } catch (e) { try { player.stop(); } catch (ee) {} }
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [disconnect-all] stopped player ${gid}\n`); } catch (e) {}
      players.delete(gid);
      disconnected.push(gid);
      try { broadcastSse(gid, { type: 'state', playing: false }); } catch (e) {}
    }
    // destroy all connections
    for (const [gid, conn] of connections.entries()) {
      try {
        // kill any ffmpeg processes for this guild
        try {
          const procs = ffmpegProcs.get(gid);
          if (procs) {
            for (const p of Array.from(procs)) {
              try { p.kill(); } catch (ee) {}
            }
            ffmpegProcs.delete(gid);
          }
        } catch (ee) {}
        // attempt to destroy any tracked connection
        try { conn.destroy(); } catch (e) { try { conn.disconnect && conn.disconnect(); } catch (ee) {} }
        // also attempt to fetch any live connection from @discordjs/voice and destroy it
        try { const live = getVoiceConnection(gid); if (live) { try { live.destroy(); } catch (ee) {} } } catch (ee) {}
      } catch (e) {}
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [disconnect-all] destroyed connection ${gid}\n`); } catch (e) {}
      connections.delete(gid);
      try { broadcastSse(gid, { type: 'state', playing: false, left: true }); } catch (e) {}
    }
      // clear persisted connections/nowPlaying when disconnecting all
      try { persistedState.connections = {}; persistedState.nowPlaying = {}; saveStateToDisk(); } catch (e) {}
      return res.json({ success: true, disconnected });
  } catch (err) {
    console.error('[disconnect-all] error', err);
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [disconnect-all] error ${err.stack || err}\n`); } catch (e) {}
    return res.status(500).json({ error: String(err && err.message) });
  }
});

// Join voice channel by id or name
app.post('/api/join', async (req, res) => {
  const { guildId, channel } = req.body;
  if (!guildId || !channel) {
    return res.status(400).json({ error: 'guildId and channel (id or name) are required' });
  }
  try {
    const guild = await client.guilds.fetch(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    let voiceChannel = guild.channels.cache.find(
      c => c.type === 2 && (c.id === channel || c.name === channel)
    );
    if (!voiceChannel) {
      // Fetch all channels if not cached
      await guild.channels.fetch();
      voiceChannel = guild.channels.cache.find(
        c => c.type === 2 && (c.id === channel || c.name === channel)
      );
    
    }
    if (!voiceChannel) return res.status(404).json({ error: 'Voice channel not found' });
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator
    });
    // store the actual VoiceConnection object for later use
    connections.set(guildId, connection);
    // persist a simple connection record immediately so callers (and tests) can observe the join
    try {
      if (!persistedState.connections) persistedState.connections = {};
      persistedState.connections[guildId] = { channelId: voiceChannel.id };
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [join] persisted connection ${guildId} -> ${voiceChannel.id}\n`); } catch (e) {}
      saveStateToDisk();
    } catch (e) {}
    // wait for the connection to be ready (best-effort)
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15000);
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [join] connection entered Ready\n`); } catch (e) {}
    } catch (e) {
      console.warn('[join] connection did not become Ready within timeout', e && e.message);
    }
  res.json({ success: true, channel: voiceChannel.name, channelId: voiceChannel.id, ready: connection.state && connection.state.status === 'ready' });
  } catch (err) {
    console.error('[join] error', err);
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [join] error ${err.stack || err}\n`); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

// Seek: restart playback for a guild at a specific position (seconds)
app.post('/api/seek', async (req, res) => {
  const { guildId, position } = req.body || {};
  if (!guildId || typeof position === 'undefined') return res.status(400).json({ error: 'guildId and position are required' });
  try {
    // find persisted track and channel
    const entry = persistedState.nowPlaying && persistedState.nowPlaying[guildId];
    if (!entry || !entry.track) return res.status(400).json({ error: 'No track persisted for this guild' });
    const rec = persistedState.connections && persistedState.connections[guildId];
    const channelId = rec && rec.channelId;
    if (!channelId) return res.status(400).json({ error: 'No persisted channel for this guild' });
    // stop any existing player
    try { if (players.has(guildId)) { try { players.get(guildId).stop(true); } catch (e) { try { players.get(guildId).stop(); } catch (ee) {} } } } catch (e) {}
    // update persisted position immediately
    try {
      if (!persistedState.nowPlaying) persistedState.nowPlaying = {};
      persistedState.nowPlaying[guildId] = { track: entry.track, position: Number(position) || 0, updated: new Date().toISOString() };
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [state] nowPlaying-set ${guildId} -> ${JSON.stringify(persistedState.nowPlaying[guildId])}\n`); } catch (e) {}
      saveStateToDisk();
    } catch (e) {}
    // start playback at requested position
    (async () => {
      try { await playTrack({ guildId, channel: channelId, track: entry.track, startPosition: Number(position) || 0 }); } catch (e) { console.error('[seek] playTrack failed', e); }
    })();
    return res.json({ success: true, position: Number(position) || 0 });
  } catch (err) {
    console.error('[seek] error', err);
    return res.status(500).json({ error: String(err && err.message) });
  }
});

// Leave a specific guild voice channel: stop player and destroy connection for guildId
app.post('/api/leave', (req, res) => {
  const { guildId } = req.body || {};
  if (!guildId) return res.status(400).json({ error: 'guildId required' });
  try {
    if (players.has(guildId)) {
      try { players.get(guildId).stop(true); } catch (e) { try { players.get(guildId).stop(); } catch (ee) {} }
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [leave] stopped player ${guildId}\n`); } catch (e) {}
      players.delete(guildId);
    }
    // destroy tracked connection and any live connection from the voice manager
    try {
      // kill ffmpeg processes for this guild
      try {
        const procs = ffmpegProcs.get(guildId);
        if (procs) {
          for (const p of Array.from(procs)) { try { p.kill(); } catch (ee) {} }
          ffmpegProcs.delete(guildId);
        }
      } catch (ee) {}
      if (connections.has(guildId)) {
        const conn = connections.get(guildId);
        try { conn.destroy(); } catch (e) { try { conn.disconnect && conn.disconnect(); } catch (ee) {} }
        connections.delete(guildId);
      }
    } catch (e) {}
    try {
      const live = getVoiceConnection(guildId);
      if (live) {
        try { live.destroy(); } catch (e) { try { live.disconnect && live.disconnect(); } catch (ee) {} }
      }
    } catch (e) {}
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [leave] destroyed connection ${guildId}\n`); } catch (e) {}
    try { broadcastSse(guildId, { type: 'state', playing: false, left: true }); } catch (e) {}
  // remove persisted connection and nowPlaying for this guild
  try {
    delete persistedState.connections[guildId];
    if (persistedState.nowPlaying) {
      persistedState.nowPlaying[guildId] = null;
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [state] nowPlaying-cleared ${guildId} (leave)\n`); } catch (e) {}
    }
    saveStateToDisk();
  } catch (e) {}
  return res.json({ success: true });
  } catch (err) {
    console.error('[leave] error', err);
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [leave] error ${err.stack || err}\n`); } catch (e) {}
    return res.status(500).json({ error: String(err && err.message) });
  }
});

// List local tracks from backend/music
// Helper: scan a directory one level deep and group files by immediate subfolder
function scanGrouped(dirPath) {
  const groups = {}; // { groupName: [ { name, relPath } ] }
  if (!fs.existsSync(dirPath)) return groups;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  // files directly inside dirPath go under group 'root'
  groups['root'] = [];
  entries.forEach(ent => {
    const entPath = path.join(dirPath, ent.name);
    if (ent.isFile()) {
      if (/\.(mp3|m4a|ogg|opus|wav)$/.test(ent.name)) {
        groups['root'].push({ name: ent.name, relPath: path.join(path.basename(dirPath), ent.name) });
      }
    } else if (ent.isDirectory()) {
      const groupName = ent.name;
      const files = fs.readdirSync(entPath).filter(f => /\.(mp3|m4a|ogg|opus|wav)$/.test(f));
      if (files.length > 0) {
        groups[groupName] = files.map(f => ({ name: f, relPath: path.join(path.basename(dirPath), groupName, f) }));
      }
    }
  });
  // remove root if empty
  if (groups['root'] && groups['root'].length === 0) delete groups['root'];
  return groups;
}

app.get('/api/tracks', (req, res) => {
  try {
    const baseMusic = path.join(__dirname, 'music');
    const baseSfx = path.join(__dirname, 'soundEffects');
    const musicGroups = scanGrouped(baseMusic);
    const sfxGroups = scanGrouped(baseSfx);
    res.json({ music: musicGroups, soundEffects: sfxGroups });
  } catch (err) {
    console.error('[tracks] scan error', err);
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [tracks] scan error ${err.stack || err}\n`); } catch (e) {}
    res.status(500).json({ error: 'Unable to scan music directories' });
  }
});

// Expose persisted state for backup/inspection (read-only)
app.get('/api/state', (req, res) => {
  try {
    // return the in-memory persistedState to avoid reading disk repeatedly
    return res.json({ state: persistedState });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message) });
  }
});

// Temporary diagnostics endpoint: returns last in-memory persistedState (fast and avoids disk timing issues)
app.get('/api/last-saved', (req, res) => {
  try {
    return res.json({ state: persistedState });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message) });
  }
});

// Helper: resolve a short sfx name to a soundEffects relative path
function findSfxByName(shortName) {
  if (!shortName) return null;
  const baseSfx = path.join(__dirname, 'soundEffects');
  // simple search for any matching filename (case-insensitive, substring)
  const walk = (dir) => {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const found = walk(p);
        if (found) return found;
      } else if (e.isFile()) {
        if (e.name.toLowerCase().includes(shortName.toLowerCase())) {
          // return path relative to backend dir, e.g. 'soundEffects/Character/Punch.mp3'
          return path.join('soundEffects', path.relative(baseSfx, p));
        }
      }
    }
    return null;
  };
  try { return walk(baseSfx); } catch (e) { return null; }
}

// Shortcut endpoint to play an SFX by short name and optional volume
app.post('/api/sfx', async (req, res) => {
  const { guildId, channel, name, volume } = req.body;
  if (!guildId || !channel || !name) return res.status(400).json({ error: 'guildId, channel, and name are required' });
  const sfxPath = findSfxByName(name);
  if (!sfxPath) return res.status(404).json({ error: 'SFX not found' });
  // call shared playTrack function directly to avoid internal HTTP and get proper stack traces
  try {
    const result = await playTrack({ guildId, channel, track: sfxPath, volume, isSfx: true });
    res.json(result);
  } catch (err) {
    console.error('[api/sfx] playTrack error', err && (err.stack || err.message));
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [api/sfx] playTrack error ${err.stack || err}
`); } catch(e) {}
    res.status(500).json({ error: String(err && err.message) });
  }
});

// Endpoint to set/get per-guild music volume
app.post('/api/volume', (req, res) => {
  const { guildId, musicVolume, sfxVolume } = req.body;
  if (!guildId) return res.status(400).json({ error: 'guildId required' });
  // if neither provided, return both current
  if (musicVolume === undefined && sfxVolume === undefined) {
    const mv = musicVolumes.has(guildId) ? musicVolumes.get(guildId) : 1;
    const sv = sfxVolumes.has(guildId) ? sfxVolumes.get(guildId) : 1;
    return res.json({ guildId, musicVolume: mv, sfxVolume: sv });
  }
  const resp = { guildId };
  if (musicVolume !== undefined) {
    const v = Number(musicVolume);
    if (!isFinite(v) || v < 0 || v > 2) return res.status(400).json({ error: 'musicVolume must be a number between 0 and 2' });
    musicVolumes.set(guildId, v);
    resp.musicVolume = v;
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [volume] set music guild ${guildId} -> ${v}\n`); } catch (e) {}
    // persist
    try { saveVolumesToDisk(); } catch (e) {}
  }
  if (sfxVolume !== undefined) {
    const sv = Number(sfxVolume);
    if (!isFinite(sv) || sv < 0 || sv > 2) return res.status(400).json({ error: 'sfxVolume must be a number between 0 and 2' });
    sfxVolumes.set(guildId, sv);
    resp.sfxVolume = sv;
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [volume] set sfx guild ${guildId} -> ${sv}\n`); } catch (e) {}
    // persist
    try { saveVolumesToDisk(); } catch (e) {}
  }
  return res.json(resp);
});

// Diagnostics endpoint: returns per-guild connection/player states and recent backend.log tail
app.get('/api/diag', (req, res) => {
  try {
    const data = {
      players: {},
      connections: {},
      logTail: null
    };
    for (const [gid, p] of players.entries()) {
      data.players[gid] = { state: p.state && p.state.status };
    }
    for (const [gid, c] of connections.entries()) {
      data.connections[gid] = { state: c.state && c.state.status };
    }
    const logPath = path.join(__dirname, '..', '..', 'backend.log');
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
      data.logTail = lines.slice(-200);
    }
    res.json(data);
  } catch (err) {
    console.error('[diag] error', err);
    res.status(500).json({ error: String(err && err.message) });
  }
});

// Debug dump endpoint: returns in-memory persistedState and recent backend.log tail
app.get('/api/debug-dump', (req, res) => {
  try {
    const data = { state: persistedState, logTail: null };
    const logPath = path.join(__dirname, '..', '..', 'backend.log');
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
      data.logTail = lines.slice(-200);
    }
    res.json(data);
  } catch (err) {
    console.error('[debug-dump] error', err);
    res.status(500).json({ error: String(err && err.message) });
  }
});

// Debug-inject endpoint: only enabled when BACKEND_ALLOW_TEST_INJECT=1
app.post('/api/debug-inject', (req, res) => {
  try {
    if (String(process.env.BACKEND_ALLOW_TEST_INJECT || '') !== '1') return res.status(403).json({ error: 'debug-inject disabled' });
    const { guildId, channelId, track } = req.body || {};
    if (!guildId || !channelId) return res.status(400).json({ error: 'guildId and channelId are required' });
    if (!persistedState.connections) persistedState.connections = {};
    if (!persistedState.nowPlaying) persistedState.nowPlaying = {};
    persistedState.connections[guildId] = { channelId };
    persistedState.nowPlaying[guildId] = { track: track || 'test-tone', position: 0, duration: null, updated: new Date().toISOString() };
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [debug-inject] injected ${guildId} -> ${JSON.stringify(persistedState.nowPlaying[guildId])}\n`); } catch (e) {}
    saveStateToDisk();
    return res.json({ success: true });
  } catch (err) {
    console.error('[debug-inject] error', err);
    return res.status(500).json({ error: String(err && err.message) });
  }
});

// Move a file from one relative path to another (both must be under backend/music or backend/soundEffects)
app.post('/api/move-file', (req, res) => {
  try {
    const { from, to, overwrite } = req.body || {};
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    // normalize and resolve
    const allowedRoots = [path.join(__dirname, 'music'), path.join(__dirname, 'soundEffects')];
    const src = path.resolve(path.join(__dirname, from));
    const dst = path.resolve(path.join(__dirname, to));
    const isUnderAllowed = (p) => allowedRoots.some(r => p === r || p.startsWith(r + path.sep));
    if (!isUnderAllowed(src) || !isUnderAllowed(dst)) return res.status(400).json({ error: 'Paths must be under music or soundEffects directories' });
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'Source file not found' });
    const dstDir = path.dirname(dst);
    if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
    // if destination exists and overwrite not allowed, return conflict
    if (fs.existsSync(dst) && !overwrite) {
      return res.status(409).json({ error: 'Destination exists' });
    }
    // perform atomic move if possible, fallback to copy+unlink
    try {
      if (fs.existsSync(dst) && overwrite) {
        try { fs.unlinkSync(dst); } catch (e) { /* ignore unlink errors */ }
      }
      fs.renameSync(src, dst);
    } catch (e) {
      // fallback
      const data = fs.readFileSync(src);
      fs.writeFileSync(dst, data);
      try { fs.unlinkSync(src); } catch (ee) { /* ignore */ }
    }
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [move-file] moved ${src} -> ${dst}\n`); } catch(e){}
    return res.json({ success: true, from, to });
  } catch (err) {
    console.error('[move-file] error', err);
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [move-file] error ${err.stack || err}\n`); } catch(e){}
    return res.status(500).json({ error: String(err && err.message) });
  }
});

// Create a new folder under music or soundEffects
app.post('/api/create-folder', (req, res) => {
  try {
    const { type, folderName } = req.body || {};
    if (!type || !folderName) return res.status(400).json({ error: 'type and folderName are required' });
    const t = (type === 'sfx' || type === 'soundEffects') ? 'soundEffects' : 'music';
    // sanitize folder name: strip path separators, nulls and trim
    const sanitized = String(folderName).replace(/[\\/:\0]/g, '').trim();
    if (!sanitized) return res.status(400).json({ error: 'invalid folder name' });
    const base = path.join(__dirname, t);
    const dest = path.join(base, sanitized);
    const resolved = path.resolve(dest);
    // ensure dest is still under base
    const baseResolved = path.resolve(base);
    if (!(resolved === baseResolved || resolved.startsWith(baseResolved + path.sep))) return res.status(400).json({ error: 'invalid folder path' });
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [create-folder] created ${dest}\n`); } catch (e) {}
      return res.json({ success: true, folder: path.join(t, sanitized) });
    }
    return res.status(409).json({ error: 'Folder already exists' });
  } catch (err) {
    console.error('[create-folder] error', err);
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [create-folder] error ${err.stack || err}\n`); } catch (e) {}
    return res.status(500).json({ error: String(err && err.message) });
  }
});

// Play a local track into a guild voice channel
app.post('/api/play', async (req, res) => {
  const { guildId, channel, track } = req.body;
  if (!guildId || !channel || !track) return res.status(400).json({ error: 'guildId, channel and track are required' });
  // delegate to shared playTrack to avoid duplicating logic
  try {
    const result = await playTrack({ guildId, channel, track, volume: req.body && req.body.volume });
    res.json(result);
  } catch (err) {
    console.error('[api/play] playTrack error', err && (err.stack || err.message));
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [api/play] playTrack error ${err.stack || err}\n`); } catch(e) {}
    res.status(500).json({ error: String(err && err.message) });
  }
});

// Shared function: plays a track (music or sfx) into a guild/channel. Returns an object { success, playing }
// Optional startPosition (seconds) will attempt to start playback from that offset using ffmpeg -ss
async function playTrack({ guildId, channel, track, volume, isSfx = false, startPosition = 0 }) {
  if (!guildId || !channel || !track) throw new Error('guildId, channel and track are required');
  const guild = await client.guilds.fetch(guildId);
  if (!guild) throw new Error('Guild not found');
  await guild.channels.fetch();
  const voiceChannel = guild.channels.cache.find(c => c.type === 2 && (c.id === channel || c.name === channel));
  if (!voiceChannel) throw new Error('Voice channel not found');

  const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
  connections.set(guildId, connection);
  // persist a simple connection record so server restarts can attempt to rejoin
  try { persistedState.connections[guildId] = { channelId: voiceChannel.id }; saveStateToDisk(); } catch (e) {}
  connection.on(VoiceConnectionStatus.Ready, () => console.log('[connection] Ready'));
  connection.on(VoiceConnectionStatus.Disconnected, () => console.log('[connection] Disconnected'));
  connection.on('error', (err) => console.error('[connection] error', err));
  try {
    connection.on('stateChange', (oldState, newState) => {
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [connection] stateChange ${oldState.status} -> ${newState.status}\n`); } catch (e) {}
      console.log('[connection] stateChange', oldState.status, '->', newState.status);
    });
  } catch (e) {}

  try {
    const me = guild.members && guild.members.me ? guild.members.me : null;
    const perms = me ? voiceChannel.permissionsFor(me) : null;
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [play] bot permissions connect:${String(perms ? perms.has('Connect') : 'unknown')} speak:${String(perms ? perms.has('Speak') : 'unknown')}\n`); } catch (e) {}
    console.log('[play] bot perms for channel connect:', perms ? perms.has('Connect') : 'unknown', 'speak:', perms ? perms.has('Speak') : 'unknown');
  } catch (e) {}

  const musicPath = path.join(__dirname, track);
  if (!fs.existsSync(musicPath)) throw new Error('Track not found');
  try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [play] queued track path: ${musicPath}\n`); } catch (e) {}

  try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [play] connection.state before subscribe: ${JSON.stringify({ status: connection.state && connection.state.status, ready: connection.state && connection.state.status === 'ready' })}\n`); } catch (e) {}
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15000);
    console.log('[play] connection entered Ready state');
  } catch (e) {
    console.warn('[play] connection did not become Ready within timeout, proceeding to subscribe anyway', e && e.message);
  }

  const guildPlayer = getPlayerForGuild(guildId);
  let subscription;
  try {
    subscription = connection.subscribe(guildPlayer);
    console.log('[play] subscription created:', !!subscription);
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [play] subscription created: ${String(!!subscription)}\n`); } catch (e) {}
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [play] connection.state after subscribe: ${JSON.stringify({ status: connection.state && connection.state.status })}\n`); } catch (e) {}
  } catch (e) {
    console.error('[play] connection.subscribe failed', e);
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [play] connection.subscribe failed ${e.stack || e}\n`); } catch (ee) {}
  }

  let ffmpegProc;
  // try to determine duration (seconds) for progress reporting
  const durationSeconds = getDurationSeconds(musicPath);
  try {
    // spawn ffmpeg normally, but include an extra pipe (fd 3) for -progress reporting when possible
    // fallback to stderr parsing if progress pipe isn't supported on platform
    const args = [
      '-hide_banner',
      '-re',
      '-loglevel', 'warning',
      '-i', musicPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '2',
      '-f', 's16le',
      '-'
    ];
    // try to add -progress pipe:3 to get periodic key=value output if ffmpeg supports it
    try { args.push('-progress', 'pipe:3'); } catch (e) {}
    // if startPosition provided and > 0, add -ss before -i for input seek
    if (startPosition && isFinite(startPosition) && Number(startPosition) > 0) {
      // insert -ss before the -i argument (we expect '-i', musicPath to be in args)
      const iIndex = args.findIndex(a => a === '-i');
      if (iIndex !== -1) {
        args.splice(iIndex, 0, '-ss', String(startPosition));
      } else {
        // fallback: put at the beginning
        args.unshift('-ss', String(startPosition));
      }
    }
    ffmpegProc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  } catch (spawnErr) {

  // track spawned ffmpeg processes so we can kill them on leave/disconnect
  try {
    if (ffmpegProc) {
      let set = ffmpegProcs.get(guildId);
      if (!set) { set = new Set(); ffmpegProcs.set(guildId, set); }
      set.add(ffmpegProc);
      const cleanupProc = () => {
        try { const s = ffmpegProcs.get(guildId); if (s) { s.delete(ffmpegProc); if (s.size === 0) ffmpegProcs.delete(guildId); } } catch (e) {}
      };
      try { ffmpegProc.on('close', cleanupProc); ffmpegProc.on('exit', cleanupProc); } catch (e) {}
    }
  } catch (e) {}
    console.error('[play] ffmpeg spawn failed', spawnErr);
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [play] ffmpeg spawn failed ${spawnErr.stack || spawnErr}\n`); } catch (e) {}
    throw spawnErr;
  }

  try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [play] ffmpeg object: ${String(!!ffmpegProc)}\n`); } catch (e) {}
  try {
    if (ffmpegProc && ffmpegProc.stderr) ffmpegProc.stderr.on('data', (d) => { try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] ffmpeg: ${d.toString()}\n`); } catch (e) {} console.error('[ffmpeg]', d.toString()); });
  } catch (e) { console.error('[play] failed attaching ffmpeg.stderr', e); }
  try {
    if (ffmpegProc && ffmpegProc.stdout && typeof ffmpegProc.stdout.on === 'function') {
      ffmpegProc.stdout.on('error', (err) => {
        // ffmpeg stdout may close prematurely when player is stopped; log and continue
        try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [ffmpeg] stdout error ${err && (err.stack || err.message)}\n`); } catch (e) {}
        // do not rethrow; this is expected when stopping playback
      });
    }
  } catch (e) {}
  try { ffmpegProc.on('error', (e) => { console.error('[ffmpeg] process error', e); }); ffmpegProc.on('close', (code, signal) => { try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] ffmpeg closed code=${code} signal=${signal}\n`); } catch (e) {} }); } catch (e) {}

  try {
    if (ffmpegProc && ffmpegProc.stdout && typeof ffmpegProc.stdout.on === 'function') {
      let chunksLogged = 0;
      ffmpegProc.stdout.on('data', (chunk) => {
        if (chunksLogged < 8) {
          try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] ffmpeg.stdout chunk ${chunksLogged} bytes=${chunk.length}\n`); } catch (e) {}
          chunksLogged++;
        }
      });
      ffmpegProc.stdout.on('error', (e) => { console.error('[ffmpeg] stdout error', e); });
    }
  } catch (e) {}

  if (!ffmpegProc || !ffmpegProc.stdout) {
    try { ffmpegProc && ffmpegProc.kill(); } catch (e) {}
    throw new Error('ffmpeg stdout not available');
  }

    if (isSfx) {
    const sfxPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    try { sfxPlayer.on('stateChange', (oldState, newState) => { try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [sfx:${guildId}] state ${oldState.status} -> ${newState.status}\n`); } catch (e) {} }); } catch (e) {}
    try {
      const sfxSub = connection.subscribe(sfxPlayer);
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [play] sfx subscription created: ${String(!!sfxSub)}\n`); } catch (e) {}
    } catch (e) { console.error('[play] sfx subscribe failed', e); }

    // pipe ffmpeg stdout through a PassThrough so we can attach error handlers and avoid unhandled stream errors
    let sfxStream = ffmpegProc && ffmpegProc.stdout ? ffmpegProc.stdout : null;
    try {
      if (sfxStream) {
        const pt = new PassThrough();
        // forward data; attach error handler to both ends
        try { sfxStream.pipe(pt); } catch (e) {}
        sfxStream.on && sfxStream.on('error', (err) => { try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [ffmpeg] original stdout error ${err && (err.stack || err.message)}\n`); } catch (e) {} });
        pt.on('error', (err) => { try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [ffmpeg] passthrough error ${err && (err.stack || err.message)}\n`); } catch (e) {} });
        sfxStream = pt;
      }
    } catch (e) {}
    const sfxResource = createAudioResource(sfxStream, { inputType: StreamType.Raw, inlineVolume: true });
    try { if (sfxResource.volume && typeof sfxResource.volume.setVolume === 'function') { const v = (typeof volume !== 'undefined' && volume !== null) ? Number(volume) : 1; sfxResource.volume.setVolume(isFinite(v) ? v : 1); } } catch (e) {}
    try {
      sfxPlayer.play(sfxResource);
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [play] sfx.play called, state: ${sfxPlayer.state && sfxPlayer.state.status}\n`); } catch (e) {}
    } catch (e) {
      try { ffmpegProc.kill(); } catch (e2) {}
      throw e;
    }

    sfxPlayer.once(AudioPlayerStatus.Idle, () => {
      try { ffmpegProc.kill(); } catch (e) {}
      try { sfxPlayer.stop(); } catch (e) {}
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [sfx:${guildId}] finished and cleaned up\n`); } catch (e) {}
    });
  } else {
    // pipe ffmpeg stdout through a PassThrough to catch premature-close / pipeline errors
    let musicStream = ffmpegProc && ffmpegProc.stdout ? ffmpegProc.stdout : null;
    try {
      if (musicStream) {
        const pt = new PassThrough();
        try { musicStream.pipe(pt); } catch (e) {}
        musicStream.on && musicStream.on('error', (err) => { try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [ffmpeg] original stdout error ${err && (err.stack || err.message)}\n`); } catch (e) {} });
        pt.on('error', (err) => { try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [ffmpeg] passthrough error ${err && (err.stack || err.message)}\n`); } catch (e) {} });
        musicStream = pt;
      }
    } catch (e) {}
    const resource = createAudioResource(musicStream, { inputType: StreamType.Raw, inlineVolume: true });
    // progress reporting: track position and broadcast via SSE every second
    let progressInterval = null;
  // start timestamp should account for startPosition so elapsed aligns with resumed position
  const startTs = Date.now() - (Number(startPosition) ? Number(startPosition) * 1000 : 0);
    const cleanupProgress = () => {
      try { if (progressInterval) { clearInterval(progressInterval); progressInterval = null; } } catch (e) {}
    };
    try {
      const vol = musicVolumes.has(guildId) ? Number(musicVolumes.get(guildId)) : 1;
      if (resource.volume && typeof resource.volume.setVolume === 'function') resource.volume.setVolume(isFinite(vol) ? vol : 1);
    } catch (e) {}
    try {
  guildPlayer.play(resource);
  // persist nowPlaying for this guild so restarts can show/restore state
  try {
    if (!persistedState.nowPlaying) persistedState.nowPlaying = {};
    persistedState.nowPlaying[guildId] = { track, position: Number(startPosition) || 0, duration: typeof durationSeconds === 'number' ? Math.floor(durationSeconds) : null, updated: new Date().toISOString() };
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [state] nowPlaying-set ${guildId} -> ${JSON.stringify(persistedState.nowPlaying[guildId])}\n`); } catch (e) {}
    saveStateToDisk();
    try { broadcastSse(guildId, { type: 'nowPlaying', nowPlaying: persistedState.nowPlaying[guildId] }); } catch (e) {}
  } catch (e) {}
  // start emitting progress events (if we have a duration or can estimate)
      // start emitting progress events (if we have a duration or can estimate)
      try {
        // derive durationSeconds earlier; if not available we still emit position as elapsed time
        let lastSavedMs = 0;
        progressInterval = setInterval(() => {
          try {
            const elapsedMs = Date.now() - startTs;
            const pos = Math.floor(elapsedMs / 1000);
            const dur = typeof durationSeconds === 'number' && isFinite(durationSeconds) ? Math.floor(durationSeconds) : null;
            try { broadcastSse(guildId, { type: 'progress', position: pos, duration: dur }); } catch (e) {}
            // persist position at most every 5 seconds
            try {
              const now = Date.now();
              if (!persistedState.nowPlaying) persistedState.nowPlaying = {};
              persistedState.nowPlaying[guildId] = { track, position: pos, duration: typeof durationSeconds === 'number' ? Math.floor(durationSeconds) : null, updated: new Date().toISOString() };
              try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [state] nowPlaying-update ${guildId} -> ${JSON.stringify(persistedState.nowPlaying[guildId])}\n`); } catch (e) {}
              try { broadcastSse(guildId, { type: 'nowPlaying', nowPlaying: persistedState.nowPlaying[guildId] }); } catch (e) {}
              if (!lastSavedMs || (now - lastSavedMs) >= 5000) {
                saveStateToDisk();
                lastSavedMs = now;
              }
            } catch (e) {}
          } catch (e) {}
        }, 1000);
      } catch (e) {}
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [play] player.play called, player state: ${guildPlayer.state && guildPlayer.state.status}\n`); } catch (e) {}
    } catch (e) {
      try { ffmpegProc.kill(); } catch (e2) {}
      throw e;
    }
    guildPlayer.once(AudioPlayerStatus.Idle, () => {
      try { ffmpegProc.kill(); } catch (e) {}
      cleanupProgress();
      // clear nowPlaying when playback finished (unless loop restarts)
    try {
      persistedState.nowPlaying[guildId] = null;
      try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [state] nowPlaying-cleared ${guildId} (idle)
`); } catch (e) {}
      saveStateToDisk();
      try { broadcastSse(guildId, { type: 'nowPlaying', nowPlaying: null }); } catch (e) {}
    } catch (e) {}
      try {
        const shouldLoop = !!loopFlags.get(guildId);
        if (shouldLoop) {
          // requeue the same track by invoking playTrack again asynchronously
          setImmediate(async () => {
            try { await playTrack({ guildId, channel, track, volume, isSfx: false }); } catch (e) { console.error('[play] loop restart failed', e); }
          });
          return;
        }
      } catch (e) {}
    });
    // also ensure progress interval is cleaned up if ffmpeg exits
    try { if (ffmpegProc) { ffmpegProc.on('exit', () => { try { if (progressInterval) clearInterval(progressInterval); } catch (e) {} }); } } catch (e) {}
  }

  return { success: true, playing: track };
}

// Test endpoint: play a generated sine tone for quick verification
app.post('/api/test-tone', async (req, res) => {
  const { guildId, channel, duration = 8 } = req.body;
  if (!guildId || !channel) return res.status(400).json({ error: 'guildId and channel are required' });
  try {
    const guild = await client.guilds.fetch(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    await guild.channels.fetch();
    const voiceChannel = guild.channels.cache.find(c => c.type === 2 && (c.id === channel || c.name === channel));
    if (!voiceChannel) return res.status(404).json({ error: 'Voice channel not found' });

  const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
  connections.set(guildId, connection);
  try { await entersState(connection, VoiceConnectionStatus.Ready, 15000); } catch (e) { /* proceed */ }
  const guildPlayer = getPlayerForGuild(guildId);
  const subscription = connection.subscribe(guildPlayer);
    // generate a sine wave using ffmpeg
    const ff = spawn(ffmpegPath, [
      '-hide_banner',
      '-f', 'lavfi',
      '-i', `sine=frequency=440:sample_rate=48000`,
      '-t', String(duration),
      '-acodec', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '2',
      '-f', 's16le',
      '-' ], { stdio: ['ignore', 'pipe', 'pipe'] });

    try { ff.stderr.on && ff.stderr.on('data', d => { try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] test-tone ffmpeg: ${d.toString()}\n`); } catch (e) {} }); } catch (e) {}
  const resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw });
  guildPlayer.play(resource);
  guildPlayer.once(AudioPlayerStatus.Idle, () => { try { ff.kill(); } catch (e) {} });
    res.json({ success: true, playing: 'test-tone', duration });
  } catch (err) {
    console.error('[test-tone] error', err);
    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [test-tone] error ${err.stack || err}\n`); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

// TODO: Add endpoints for play, pause, skip, queue, etc.

// Start server and Discord client only when run directly (not when imported by tests)
if (require.main === module) {
  app.listen(PORT, () => console.log(`Backend API running on port ${PORT}`));

  client.once('ready', () => {
    console.log(`Discord bot logged in as ${client.user.tag}`);
    // attempt to restore persisted connections and nowPlaying
    (async () => {
      try {
        for (const [gid, rec] of Object.entries(persistedState.connections || {})) {
          try {
            const channelId = rec && rec.channelId;
            if (!channelId) continue;
            const guild = await client.guilds.fetch(gid).catch(() => null);
            if (!guild) {
              try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [restore] guild ${gid} not available (skipping)\n`); } catch (e) {}
              continue;
            }
            await guild.channels.fetch().catch(() => {});
            const voiceChannel = guild.channels.cache.get(channelId) || guild.channels.cache.find(c => c.id === channelId);
            if (!voiceChannel) {
              try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [restore] channel ${channelId} not found in guild ${gid} (skipping)\n`); } catch (e) {}
              continue;
            }
            let joined = false;
            try {
              const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
              connections.set(gid, connection);
              try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [restore] rejoined guild ${gid} channel ${voiceChannel.id}\n`); } catch (e) {}
              joined = true;
            } catch (e) {
              try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [restore] initial join failed for ${gid}/${channelId}: ${e && (e.stack || e.message)}\n`); } catch (ee) {}
            }
            // attempt one retry after a short delay if initial join failed
            if (!joined) {
              try {
                await new Promise(r => setTimeout(r, 1200));
                const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator });
                connections.set(gid, connection);
                try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [restore] retry rejoined guild ${gid} channel ${voiceChannel.id}\n`); } catch (e) {}
                joined = true;
              } catch (e) {
                try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [restore] retry failed for ${gid}/${channelId}: ${e && (e.stack || e.message)}\n`); } catch (ee) {}
              }
            }
            // if there was a nowPlaying entry for this guild, try to resume it
            const np = persistedState.nowPlaying && persistedState.nowPlaying[gid];
            if (np && joined) {
              try {
                // small delay between resumes to avoid hammering the API
                await new Promise(r => setTimeout(r, 800));
                // np may be an object { track, position } or a legacy string
                const trackPath = (typeof np === 'string') ? np : (np && np.track);
                const startPos = (np && typeof np.position === 'number') ? np.position : ((np && np.position) ? Number(np.position) : 0);
                if (trackPath && !trackPath.startsWith('soundEffects')) {
                  try {
                    await playTrack({ guildId: gid, channel: channelId, track: trackPath, startPosition: startPos });
                    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [restore] resumed ${trackPath} for ${gid} at ${startPos}s\n`); } catch (e) {}
                  } catch (e) {
                    try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [restore] failed to resume ${trackPath} for ${gid}: ${e && (e.stack || e.message)}\n`); } catch (ee) {}
                  }
                } else {
                  // skip resuming SFX entries
                }
              } catch (e) {
                try { require('fs').appendFileSync(path.join(__dirname, '..', '..', 'backend.log'), `[${new Date().toISOString()}] [restore] failed to process nowPlaying for ${gid}: ${e && (e.stack || e.message)}\n`); } catch (ee) {}
              }
            }
          } catch (e) {}
        }
      } catch (e) {
        console.error('[restore] error', e);
      }
    })();
  });

  client.login(process.env.DISCORD_TOKEN);
}

module.exports = { scanGrouped, app, PORT };
