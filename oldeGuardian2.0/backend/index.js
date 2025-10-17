require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const SpotifyWebApi = require('spotify-web-api-node');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, createAudioResource: _createAudioResource } = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3001;

// Discord client setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages] });

// Placeholder for music queue and player
let queue = [];
let player = createAudioPlayer();
let currentConnection = null;

// Express API for frontend control
app.use(express.json());


app.get('/api/status', (req, res) => {
  res.json({ playing: player.state.status === AudioPlayerStatus.Playing, queue });
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
    joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator
    });
    // store a reference to the connection if needed later (fetch from client)
    currentConnection = { guildId: guild.id, channelId: voiceChannel.id };
    res.json({ success: true, channel: voiceChannel.name, channelId: voiceChannel.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: 'Unable to scan music directories' });
  }
});

// Play a local track into a guild voice channel
app.post('/api/play', async (req, res) => {
  const { guildId, channel, track } = req.body;
  if (!guildId || !channel || !track) return res.status(400).json({ error: 'guildId, channel and track are required' });
  try {
    const guild = await client.guilds.fetch(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    await guild.channels.fetch();
    let voiceChannel = guild.channels.cache.find(c => c.type === 2 && (c.id === channel || c.name === channel));
    if (!voiceChannel) return res.status(404).json({ error: 'Voice channel not found' });

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator
    });

    // spawn ffmpeg to convert the file to opus stream for discord
  // track is expected to be a relative path like 'music/battle/track.opus' or 'soundEffects/sfx.wav'
  const musicPath = path.join(__dirname, track);
    if (!fs.existsSync(musicPath)) return res.status(404).json({ error: 'Track not found' });

    const ffmpeg = spawn(ffmpegPath, [
      '-i', musicPath,
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-f', 'opus',
      '-ar', '48000',
      '-ac', '2',
      '-' // output to stdout
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    const resource = createAudioResource(ffmpeg.stdout, { inputType: 'opus' });
    player.play(resource);
    connection.subscribe(player);

    player.once(AudioPlayerStatus.Idle, () => {
      // cleanup if needed
      try { ffmpeg.kill(); } catch (e) {}
    });

    res.json({ success: true, playing: track });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TODO: Add endpoints for play, pause, skip, queue, etc.

app.listen(PORT, () => console.log(`Backend API running on port ${PORT}`));

client.once('ready', () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
