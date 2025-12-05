import React, { useEffect, useState } from 'react';
import axios from 'axios';

function App() {
  const [guildId, setGuildId] = useState('');
  const [channel, setChannel] = useState('');
  const [tracks, setTracks] = useState([]);
  const [collapsed, setCollapsed] = useState({}); // groupName -> bool
  const [message, setMessage] = useState(null);
  const [nowPlaying, setNowPlaying] = useState('');
  const [musicVolume, setMusicVolume] = useState(1);
  const [sfxVolume, setSfxVolume] = useState(1);
  const [channels, setChannels] = useState([
    { id: '965874270221787176', label: 'OG DnD', guildId: '491059674095943680' },
    { id: '1113241781660819558', label: 'Hutts n D', guildId: '412088685916323862' },
    { id: '1117264408909983934', label: 'PSU DnD', guildId: '491059674095943680' },
    { id: '975071771147505760', label: 'SCC DnD', guildId: '975071770690330666' },
    { id: '491059674095943684', label: 'OG gen', guildId: '491059674095943680' },
  ]);
  const [eventSource, setEventSource] = useState(null);
  const [connectedGuilds, setConnectedGuilds] = useState(new Set());
  const [newChannelLabel, setNewChannelLabel] = useState('');
  const [newChannelId, setNewChannelId] = useState('');
  const [newChannelGuildId, setNewChannelGuildId] = useState('');
  const [createFolderType, setCreateFolderType] = useState('music');
  const [createFolderName, setCreateFolderName] = useState('');
  const [dragOverTarget, setDragOverTarget] = useState(null); // key for visual highlight
  const [conflict, setConflict] = useState(null); // { fromRel, toRel, filename }
  const [renameInput, setRenameInput] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const [logLines, setLogLines] = useState([]);
  const [logPolling, setLogPolling] = useState(false);

  useEffect(() => {
    fetchTracks();
  }, []);

  // initialize Materialize FormSelect when M is available and channels change
  useEffect(() => {
    if (window.M) {
      const elems = document.querySelectorAll('select');
      if (elems && elems.length) window.M.FormSelect.init(elems);
    }
  }, [channels]);

  // initialize Materialize Modal when M is available
  useEffect(() => {
    if (window.M) {
      const modalElem = document.getElementById('createFolderModal');
      if (modalElem) window.M.Modal.init(modalElem);
    }
  }, []);

  // when channel (and guildId) changes, fetch current volumes
  useEffect(() => {
    const fetchVolumes = async () => {
      if (!guildId) return;
      try {
        const res = await axios.post('/api/volume', { guildId });
        if (res && res.data) {
          if (typeof res.data.musicVolume !== 'undefined') setMusicVolume(res.data.musicVolume);
          if (typeof res.data.sfxVolume !== 'undefined') setSfxVolume(res.data.sfxVolume);
        }
      } catch (e) {
        // ignore
      }
    };
    fetchVolumes();
  }, [guildId, channel]);

  // refresh diagnostic info (connections) so UI can reflect whether a guild is connected
  const refreshDiag = async () => {
    try {
      const res = await axios.get('/api/diag');
      const conns = res.data && res.data.connections ? res.data.connections : {};
      // res.data.connections is an object keyed by guildId
      setConnectedGuilds(new Set(Object.keys(conns || {})));
    } catch (e) {
      // ignore diag errors
    }
  };

  // fetch diag on mount and when selected guild changes so Leave button can be enabled/disabled
  useEffect(() => {
    refreshDiag();
  }, []);

  useEffect(() => {
    if (guildId) refreshDiag();
  }, [guildId]);

  // client-side duration probe: returns seconds or null
  const probeDuration = (relPath) => new Promise((resolve) => {
    if (!relPath) return resolve(null);
    try {
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      audio.src = `/api/media?path=${encodeURIComponent(relPath)}`;
      const onLoaded = () => {
        try { const d = isFinite(audio.duration) ? Math.floor(audio.duration) : null; audio.removeEventListener('loadedmetadata', onLoaded); audio.pause(); resolve(d); } catch (e) { resolve(null); }
      };
      audio.addEventListener('loadedmetadata', onLoaded);
      audio.addEventListener('error', () => { try { audio.removeEventListener('loadedmetadata', onLoaded); } catch (e) {} resolve(null); });
      // attempt to load
      audio.load();
      // timeout fallback
      setTimeout(() => { try { audio.removeEventListener('loadedmetadata', onLoaded); } catch (e) {} resolve(null); }, 4000);
    } catch (e) { resolve(null); }
  });

  const fetchTracks = async () => {
    try {
      const res = await axios.get('/api/tracks');
      // expect { music: { group: [ {name, relPath} ] }, soundEffects: { ... } }
      setTracks(res.data || {});
      // initialize collapsed state for groups (default collapsed)
      const col = {};
      if (res.data && res.data.music) Object.keys(res.data.music).forEach(g => col[`music:${g}`] = true);
      if (res.data && res.data.soundEffects) Object.keys(res.data.soundEffects).forEach(g => col[`sfx:${g}`] = true);
      setCollapsed(col);
    } catch (err) {
      setMessage({ error: err.response?.data?.error || err.message });
    }
  };

  // helper: move file by calling backend
  const moveFile = async (fromRel, toRel, options = {}) => {
    try {
      const body = { from: fromRel, to: toRel };
      if (options.overwrite) body.overwrite = true;
      await axios.post('/api/move-file', body);
      setMessage({ success: `Moved ${fromRel} -> ${toRel}` });
      fetchTracks();
    } catch (e) {
      // bubble up so caller can handle conflict modal
      throw e;
    }
  };

  const targetExists = (toRel) => {
    // toRel like 'music\\Group\\file.mp3' or 'soundEffects\\file.mp3'
    if (!toRel) return false;
    const parts = toRel.split('\\');
    if (parts.length < 2) return false;
    const root = parts[0];
    const maybeGroup = parts.length === 2 ? 'root' : parts[1];
    const filename = parts[parts.length - 1];
    if (root === 'music') {
      const groups = tracks.music || {};
      const groupList = groups[maybeGroup];
      if (!groupList) return false;
      return groupList.some(it => it.name === filename);
    }
    if (root === 'soundEffects') {
      const groups = tracks.soundEffects || {};
      const groupList = groups[maybeGroup];
      if (!groupList) return false;
      return groupList.some(it => it.name === filename);
    }
    return false;
  };

  const attemptMove = async (fromRel, toRel) => {
    try {
      if (targetExists(toRel)) {
        const filename = toRel.split('\\').pop();
        setConflict({ fromRel, toRel, filename });
        setRenameInput(filename);
        const modal = window.M.Modal.getInstance(document.getElementById('conflictModal'));
        modal.open();
        return;
      }
      await moveFile(fromRel, toRel);
    } catch (e) {
      // if backend reports conflict, surface modal
      if (e.response && e.response.status === 409) {
        const filename = toRel.split('\\').pop();
        setConflict({ fromRel, toRel, filename });
        setRenameInput(filename);
        const modal = window.M.Modal.getInstance(document.getElementById('conflictModal'));
        modal.open();
        return;
      }
      setMessage({ error: e.response?.data?.error || e.message });
    }
  };

  const [joined, setJoined] = useState(false);
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [isPlayingRemote, setIsPlayingRemote] = useState(false);
  const [position, setPosition] = useState(null);
  const [duration, setDuration] = useState(null);
  const [seeking, setSeeking] = useState(false);
  const [statusPolling, setStatusPolling] = useState(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [lastPositionUpdate, setLastPositionUpdate] = useState({ position: 0, timestamp: Date.now() });
  // derived connected state: true if we think we're joined locally or diag reports a connection for this guild
  const isConnected = joined || (guildId && connectedGuilds.has(guildId));
  const handleJoin = async () => {
    if (!channel) return setMessage({ error: 'Channel required to join.' });
    try {
      const res = await axios.post('/api/join', { guildId, channel });
      setMessage({ success: `Joined ${res.data.channel}` });
      setJoined(true);
      // refresh diag so UI knows the backend connection state
      try { refreshDiag(); } catch (e) {}
      // auto-hide add-channel inputs
      setShowAddChannel(false);
      // open Server-Sent Events connection for this guild
      try {
        if (eventSource) { try { eventSource.close(); } catch (e) {} }
        const es = new EventSource(`/api/events?guildId=${encodeURIComponent(guildId)}`);
        es.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data);
            if (!data) return;
            if (data.type === 'status') {
              setIsPlayingRemote(!!data.playing);
              setIsLooping(!!data.loop);
              // initial status may include persisted nowPlaying
              if (data.nowPlaying) {
                const np = data.nowPlaying;
                const trackName = typeof np === 'string' ? np.split('\\').pop().split('/').pop() : (np.track ? String(np.track).split('\\').pop().split('/').pop() : 'Unknown');
                setNowPlaying(trackName);
                try { setDuration(typeof np.duration === 'number' ? np.duration : (np && np.duration ? Number(np.duration) : null)); } catch (e) {}
                try { setPosition(typeof np.position === 'number' ? np.position : (np && np.position ? Number(np.position) : null)); } catch (e) {}
                    // probe duration client-side if backend didn't provide it and we have a track path
                    try { if ((!np || typeof np.duration !== 'number') && np && np.track) { probeDuration(np.track).then(d => { if (d) setDuration(d); }); } } catch (e) {}
              }
            }
            if (data.type === 'state') {
              setIsPlayingRemote(!!data.playing);
            }
            if (data.type === 'nowPlaying') {
              const np = data.nowPlaying;
              if (!np) {
                setNowPlaying(''); setDuration(null); setPosition(null);
              } else {
                const trackName = typeof np === 'string' ? np.split('\\').pop().split('/').pop() : (np.track ? String(np.track).split('\\').pop().split('/').pop() : 'Unknown');
                setNowPlaying(trackName);
                try { setDuration(typeof np.duration === 'number' ? np.duration : (np && np.duration ? Number(np.duration) : null)); } catch (e) {}
                try { setPosition(typeof np.position === 'number' ? np.position : (np && np.position ? Number(np.position) : null)); } catch (e) {}
                  // if no duration provided, attempt client-side probe using the track path
                  try { if ((!np || typeof np.duration !== 'number') && np && np.track) { probeDuration(np.track).then(d => { if (d) setDuration(d); }); } } catch (e) {}
              }
            }
            if (data.type === 'progress') {
              try {
                if (!seeking) {
                  const pos = typeof data.position === 'number' ? data.position : null;
                  setPosition(pos);
                  if (pos !== null) setLastPositionUpdate({ position: pos, timestamp: Date.now() });
                }
              } catch (e) {}
              try { setDuration(typeof data.duration === 'number' ? data.duration : null); } catch (e) {}
            }
            if (data.type === 'loop') {
              setIsLooping(!!data.loop);
            }
          } catch (e) {}
        };
        es.onerror = () => { /* ignore errors, will try to reconnect server-side */ };
        setEventSource(es);
      } catch (e) {}
    } catch (err) {
      setMessage({ error: err.response?.data?.error || err.message });
    }
  };

  const handlePlay = async (track) => {
    if (!guildId || !channel) return setMessage({ error: 'Guild ID and channel required to play.' });
    try {
      const res = await axios.post('/api/play', { guildId, channel, track: track.relPath });
      setMessage({ success: `Playing ${track.name}` });
      setNowPlaying(track.name || track.relPath || 'Unknown');
      // mark player as playing so Pause becomes active immediately
      setIsPlayingRemote(true);
      // reset progress display when starting a new track
      setPosition(0);
      setLastPositionUpdate({ position: 0, timestamp: Date.now() });
      // set duration if backend provided it
      if (res && res.data && typeof res.data.duration === 'number') setDuration(res.data.duration);
      else {
        // fallback: probe the track file for duration
        try { probeDuration(track.relPath).then(d => { if (d) setDuration(d); }); } catch (e) {}
      }
    } catch (err) {
      setMessage({ error: err.response?.data?.error || err.message });
    }
  };

  // cleanup polling timer on unmount
  useEffect(() => {
    return () => {
      try { if (statusPolling) clearInterval(statusPolling); } catch (e) {}
    };
  }, [statusPolling]);

  // Interpolate position during playback for smooth slider movement
  useEffect(() => {
    if (!isPlayingRemote || seeking) return;
    const interval = setInterval(() => {
      try {
        if (lastPositionUpdate && typeof lastPositionUpdate.position === 'number') {
          const elapsed = (Date.now() - lastPositionUpdate.timestamp) / 1000;
          const estimatedPosition = lastPositionUpdate.position + elapsed;
          if (duration && estimatedPosition <= duration) {
            setPosition(Math.round(estimatedPosition * 10) / 10);
          } else if (duration && estimatedPosition > duration) {
            setPosition(duration);
          }
        }
      } catch (e) {}
    }, 100);
    return () => clearInterval(interval);
  }, [isPlayingRemote, seeking, lastPositionUpdate, duration]);

  // Poll /api/diag when log viewer is open
  useEffect(() => {
    let timer = null;
    const fetchTail = async () => {
      try {
        const res = await axios.get('/api/diag');
        const tail = res.data && res.data.logTail ? res.data.logTail : [];
        setLogLines(tail);
      } catch (e) {
        // ignore polling errors
      }
    };
    if (showLogs && logPolling) {
      // initial fetch was performed on button press; start periodic refresh
      timer = setInterval(fetchTail, 2500);
    }
    return () => { try { if (timer) clearInterval(timer); } catch (e) {} };
  }, [showLogs, logPolling]);

  const handleSfx = async (item) => {
    if (!guildId || !channel) return setMessage({ error: 'Guild ID and channel required to play sfx.' });
    try {
      const name = item.name.replace(/\.[^.]+$/, ''); // strip extension
      await axios.post('/api/sfx', { guildId, channel, name, volume: sfxVolume });
      setMessage({ success: `Played SFX ${item.name}` });
    } catch (err) {
      setMessage({ error: err.response?.data?.error || err.message });
    }
  };

  return (
    <div className="App" style={{ padding: 20 }}>
      {/* Centered header with placeholder skull image */}
      <div style={{ textAlign: 'center', marginBottom: 12 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <img alt="skull placeholder" src={`data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.2"><path d="M12 2c-1.1 0-2 .9-2 2v1H7c-2 0-3 1.5-3 3v3c0 2 1 4 4 4v2h6v-2c3 0 4-2 4-4V8c0-1.5-1-3-3-3h-3V4c0-1.1-.9-2-2-2zM9 15s.5 1 3 1 3-1 3-1M9.5 10.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm9 0a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z"/></g></svg>')}`} style={{ width: 36, height: 36, color: 'var(--primary)' }} />
          <h1 className="header" style={{ margin: 0 }}>oldeGuardian</h1>
        </div>
      </div>

      {/* Feedback (moved under header) */}
      {/* feedback moved above */}

      {/* Centered music player controls with compact Now Playing next to controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 8 }}>
        <div style={{ width: 160, minWidth: 120, textAlign: 'left', overflow: 'hidden' }}>
          <div style={{ fontSize: 12, color: '#444', whiteSpace: 'nowrap' }}><strong>Now playing</strong></div>
          <div style={{ fontSize: 13, color: 'var(--primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nowPlaying || '—'}</div>
        </div>
          <div style={{ width: 300, minWidth: 160 }}>
            <div>
              {duration ? (
                <div>
                  <input
                    type="range"
                    min={0}
                    max={duration}
                    step={1}
                    value={position != null ? position : 0}
                    onChange={e => { setSeeking(true); setPosition(Number(e.target.value)); }}
                    onMouseUp={async e => {
                      setSeeking(false);
                      const pos = Number(e.target.value);
                      try { await axios.post('/api/seek', { guildId, position: pos }); setMessage({ success: `Seeked to ${pos}s` }); } catch (err) { setMessage({ error: err.response?.data?.error || err.message }); }
                    }}
                    onTouchEnd={async e => {
                      setSeeking(false);
                      const pos = Number(e.target.value);
                      try { await axios.post('/api/seek', { guildId, position: pos }); setMessage({ success: `Seeked to ${pos}s` }); } catch (err) { setMessage({ error: err.response?.data?.error || err.message }); }
                    }}
                    style={{ width: '100%' }}
                  />
                  <div style={{ fontSize: 11, color: '#666', display: 'flex', justifyContent: 'space-between' }}>
                    <div>{position != null ? new Date(position * 1000).toISOString().substr(14, 5) : '—:—'}</div>
                    <div>{duration != null ? new Date(duration * 1000).toISOString().substr(14, 5) : '—:—'}</div>
                  </div>
                </div>
              ) : (
                <div style={{ height: 8, background: '#eee', borderRadius: 4, overflow: 'hidden' }} aria-hidden>
                  <div style={{ height: '100%', background: 'var(--primary)', width: position ? '2%' : '0%', transition: 'width 300ms linear' }} />
                </div>
              )}
            </div>
          </div>
        <div className="player-controls" role="group" aria-label="Player controls">
          <button className="btn" disabled={!isConnected || !nowPlaying} onClick={async () => {
          if (!guildId) return setMessage({ error: 'Select guild/channel before controlling player' });
          try { await axios.post('/api/player', { guildId, action: 'stop' }); setIsPlayingRemote(false); setNowPlaying(''); setPosition(null); setDuration(null); setMessage({ success: 'Stopped' }); } catch (e) { setMessage({ error: e.response?.data?.error || e.message }); }
        }}><i className="material-icons">stop</i></button>
          <button className="btn" disabled={!isConnected || !isPlayingRemote} onClick={async () => {
          if (!guildId) return setMessage({ error: 'Select guild/channel before controlling player' });
          try { await axios.post('/api/player', { guildId, action: 'pause' }); setIsPlayingRemote(false); setMessage({ success: 'Paused' }); } catch (e) { setMessage({ error: e.response?.data?.error || e.message }); }
        }}><i className="material-icons">pause</i></button>
  <button className="btn" disabled={!isConnected || isPlayingRemote} onClick={async () => {
          if (!guildId) return setMessage({ error: 'Select guild/channel before controlling player' });
          try {
            const res = await axios.post('/api/player', { guildId, action: 'resume' });
            setIsPlayingRemote(true);
            setMessage({ success: 'Resumed' });
            if (res && res.data && typeof res.data.duration === 'number') setDuration(res.data.duration);
            if (res && res.data && typeof res.data.position === 'number') {
              setPosition(res.data.position);
              setLastPositionUpdate({ position: res.data.position, timestamp: Date.now() });
            }
          } catch (e) { setMessage({ error: e.response?.data?.error || e.message }); }
        }}><i className="material-icons">play_arrow</i></button>
  <button className={`btn ${isLooping ? 'teal loop-on' : ''}`} disabled={!isConnected} onClick={async () => {
          if (!guildId) return setMessage({ error: 'Select guild/channel before controlling player' });
          try { const res = await axios.post('/api/player', { guildId, action: 'toggleLoop' }); setIsLooping(!!res.data.loop); setMessage({ success: `Loop ${res.data.loop ? 'enabled' : 'disabled'}` }); } catch (e) { setMessage({ error: e.response?.data?.error || e.message }); }
        }}><i className="material-icons">repeat</i></button>
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 260 }}>
            <label htmlFor="channelSelect" style={{ marginRight: 8 }}>Channel</label>
            <select id="channelSelect" aria-label="Select channel" value={channel} onChange={e => {
              const val = e.target.value;
              setChannel(val);
              const found = channels.find(c => c.id === val);
              if (found) setGuildId(found.guildId || '');
            }} style={{ width: '33%', minWidth: 180 }}>
              <option value="">-- Select Channel --</option>
              {channels.map(ch => (
                <option key={ch.id} value={ch.id}>{ch.label || ch.id}</option>
              ))}
            </select>
            <button className="btn-compact" onClick={handleJoin} style={{ marginLeft: 8 }}>Join</button>
            <button
              className="btn-compact"
              onClick={async () => {
                if (!guildId) return setMessage({ error: 'guildId required to leave' });
                try {
                  await axios.post('/api/player', { guildId, action: 'stop' });
                  await axios.post('/api/leave', { guildId });
                  try { if (eventSource) { eventSource.close(); setEventSource(null); } } catch (e) {}
                  setJoined(false);
                  setMessage({ success: 'Left channel' });
                  setNowPlaying('');
                  // refresh diagnostics so UI updates
                  refreshDiag();
                } catch (e) {
                  setMessage({ error: e.response?.data?.error || e.message });
                }
              }}
              style={{ marginLeft: 6 }}
              disabled={!connectedGuilds.has(guildId)}
              title={!guildId ? 'Select a channel/guild first' : (!connectedGuilds.has(guildId) ? 'Bot is not connected to the selected guild' : 'Leave this guild')}
            >Leave</button>
          </div>

          {/* Refresh remains visible regardless of join state; placed visually beside controls */}
          <div style={{ marginLeft: 'auto' }}>
            <button className="btn-compact" onClick={fetchTracks}>Refresh</button>
            <button className="btn-compact" onClick={async () => {
              try {
                const res = await axios.get('/api/state');
                const dataStr = JSON.stringify(res.data && res.data.state ? res.data.state : res.data, null, 2);
                const blob = new Blob([dataStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `oldeGuardian_state_${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
                setMessage({ success: 'State downloaded' });
              } catch (e) {
                setMessage({ error: e.response?.data?.error || e.message });
              }
            }} style={{ marginLeft: 8 }}>Download state</button>
            <button className="btn-compact" onClick={async () => {
              try {
                const res = await axios.get('/api/diag');
                const tail = res.data && res.data.logTail ? res.data.logTail : [];
                setLogLines(tail);
                setShowLogs(true);
                setLogPolling(true);
              } catch (e) {
                setMessage({ error: e.response?.data?.error || e.message });
              }
            }} style={{ marginLeft: 8 }}>Show logs</button>
          </div>
        </div>

        {/* hidden add-channel line toggled by clickable text */}
        <div style={{ marginTop: 8 }}>
          {!showAddChannel ? (
            <div style={{ color: 'var(--primary)', cursor: 'pointer', fontSize: 13 }} onClick={() => setShowAddChannel(true)}>click here to add another channel</div>
          ) : (
            <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input placeholder="Label" value={newChannelLabel} onChange={e => setNewChannelLabel(e.target.value)} style={{ width: 120 }} />
              <input placeholder="Channel ID" value={newChannelId} onChange={e => setNewChannelId(e.target.value)} style={{ width: 200 }} />
              <input placeholder="Guild ID" value={newChannelGuildId} onChange={e => setNewChannelGuildId(e.target.value)} style={{ width: 200 }} />
              <button className="btn-compact" onClick={() => {
                if (!newChannelId) return setMessage({ error: 'Channel ID required' });
                if (!newChannelGuildId) return setMessage({ error: 'Guild ID required' });
                const lbl = newChannelLabel || newChannelId;
                setChannels(prev => [...prev, { id: newChannelId, label: lbl, guildId: newChannelGuildId }]);
                setNewChannelLabel(''); setNewChannelId(''); setNewChannelGuildId('');
                setMessage({ success: `Added channel ${lbl}` });
              }}>Add</button>
              <button className="btn-compact" onClick={() => setShowAddChannel(false)} style={{ marginLeft: 6 }}>Cancel</button>
            </div>
          )}
        </div>
      </div>

      {/* feedback shown under header (already rendered above) */}

      {/* Log viewer panel (simple) */}
      {showLogs && (
        <div style={{ position: 'fixed', right: 12, top: 72, width: 640, maxHeight: '60vh', background: '#fff', border: '1px solid #ddd', boxShadow: '0 6px 18px rgba(0,0,0,0.12)', padding: 12, overflow: 'auto', zIndex: 9999 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong>Backend log tail</strong>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 12, color: '#666' }}>{logPolling ? 'polling...' : ''}</div>
              <button className="btn-compact" onClick={() => { setShowLogs(false); setLogLines([]); setLogPolling(false); }} style={{ marginLeft: 8 }}>Close</button>
            </div>
          </div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#222' }}>
            {logLines.length === 0 ? <div style={{ color: '#666' }}>No logs available</div> : logLines.map((ln, i) => (
              <div key={i} style={{ padding: '2px 0', borderBottom: '1px solid #f4f4f4' }}>{ln}</div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 24 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
              <i className="material-icons" style={{ fontSize: 28 }}>music_note</i>
              Music
            </h2>
          </div>
          <div
            role="button"
            aria-label="Drop to music root"
            title="Drop files/folders here to move to music root"
            style={{
              padding: 24,
              marginBottom: 12,
              backgroundColor: dragOverTarget === 'music:root' ? '#c8e6c9' : '#f5f5f5',
              border: '2px dashed ' + (dragOverTarget === 'music:root' ? '#4caf50' : '#ccc'),
              borderRadius: 8,
              textAlign: 'center',
              cursor: 'pointer',
              transition: 'all 0.2s ease'
            }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverTarget('music:root'); }}
            onDragLeave={() => setDragOverTarget(null)}
            onDrop={(e) => {
              e.preventDefault(); setDragOverTarget(null);
              const rel = e.dataTransfer.getData('text/plain'); if (!rel) return; const filename = rel.split('\\').pop(); const target = `music\\${filename}`; attemptMove(rel, target);
            }}
          >
            <i className="material-icons" style={{ fontSize: 32, color: '#999', display: 'block', marginBottom: 8 }}>upload_file</i>
            <div style={{ color: '#666', fontSize: 13 }}>Drop files/folders here</div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <button className="btn" onClick={() => {
              const modal = window.M.Modal.getInstance(document.getElementById('createFolderModal'));
              // default to music type
              setCreateFolderType('music');
              setCreateFolderName('');
              modal.open();
            }}><i className="material-icons" style={{ fontSize: 20, marginRight: 4 }}>create_new_folder</i>Create Folder</button>
          </div>
          <div style={{ marginBottom: 8 }}>
        <label>Music volume: </label>
        <input type="range" min="0" max="2" step="0.05" value={musicVolume} onChange={async e => {
          const v = Number(e.target.value); setMusicVolume(v);
          if (guildId) {
            try { 
              await axios.post('/api/volume', { guildId, musicVolume: v }); 
              // Also update the currently playing track's volume in real-time
              await axios.post('/api/update-volume', { guildId });
            } catch (e) { /* ignore */ }
          }
        }} style={{ width: 300 }} />
        <span style={{ marginLeft: 8 }}>{musicVolume.toFixed(2)}</span>
          </div>
          {/* moved Refresh to top near join */}
          {/* list area is scrollable so header and controls stay visible */}
          <div className="list-area" style={{ overflowY: 'auto', maxHeight: '60vh', paddingRight: 8 }}>
          {/* root drop target moved to header icon */}
          {tracks.music ? Object.keys(tracks.music).map(group => (
            <div key={group} style={{ marginTop: 12 }}>
                <h3
                  style={{ cursor: 'pointer' }}
                  onClick={() => setCollapsed(prev => ({ ...prev, [`music:${group}`]: !prev[`music:${group}`] }))}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                  onDragEnter={() => setDragOverTarget(`music:${group}`)}
                  onDragLeave={() => setDragOverTarget(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOverTarget(null);
                    const rel = e.dataTransfer.getData('text/plain');
                    if (!rel) return;
                    const filename = rel.split('\\').pop();
                    const target = `music\\${group}\\${filename}`;
                    // ensure group is open so moved file is visible
                    setCollapsed(prev => ({ ...prev, [`music:${group}`]: false }));
                    attemptMove(rel, target);
                  }}
                  className={`group-header ${dragOverTarget === ('music:' + group) ? 'teal lighten-4' : ''}`}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1 }}>{group}</span>
                    <button
                      className="btn-small teal"
                      onClick={async (e) => {
                        e.stopPropagation();
                        const fileCount = tracks.music[group].length;
                        const message = fileCount > 0
                          ? `Delete folder "${group}" and ${fileCount} file(s) inside?`
                          : `Delete empty folder "${group}"?`;
                        if (!window.confirm(message)) return;
                        try {
                          await axios.post('/api/delete-folder', { type: 'music', folderName: group });
                          setMessage({ success: `Deleted folder ${group}` });
                          await fetchTracks();
                        } catch (e) {
                          setMessage({ error: e.response?.data?.error || e.message });
                        }
                      }}
                      style={{ padding: '0 8px', height: 24, lineHeight: '24px', fontSize: 11 }}
                      title="Delete folder"
                    >
                      <i className="material-icons" style={{ fontSize: 16, color: 'white' }}>delete</i>
                    </button>
                    <i className="material-icons" aria-hidden>{collapsed[`music:${group}`] ? 'chevron_right' : 'expand_more'}</i>
                  </span>
                </h3>
              {!collapsed[`music:${group}`] && (
                <ul onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
                  e.preventDefault();
                  const rel = e.dataTransfer.getData('text/plain');
                  if (!rel) return;
                  const filename = rel.split('\\').pop();
                  const target = `music\\${group}\\${filename}`;
                  attemptMove(rel, target);
                }}>
                  {tracks.music[group].length === 0 && (
                    <li style={{ marginTop: 6, fontSize: 13, color: '#999', fontStyle: 'italic' }}>Empty folder</li>
                  )}
                  {tracks.music[group].map(item => (
                    <li key={item.relPath} className="list-item" style={{ marginTop: 6, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }} draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', item.relPath); e.dataTransfer.setData('source', 'music'); }} onClick={() => handlePlay(item)}>
                      <span style={{ flex: 1 }}>{item.name}</span>
                      <button aria-label={`Play ${item.name}`} className="btn" onClick={(e) => { e.stopPropagation(); handlePlay(item); }} style={{ marginLeft: 8, padding: '0 8px', height: 28 }}>Play</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )) : <div>No music found</div>}
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <i className="material-icons" style={{ fontSize: 28 }}>graphic_eq</i>
            SFX
          </h2>
          <div
            role="button"
            aria-label="Drop to sfx root"
            title="Drop files/folders here to move to soundEffects root"
            style={{
              padding: 24,
              marginBottom: 12,
              backgroundColor: dragOverTarget === 'sfx:root' ? '#c8e6c9' : '#f5f5f5',
              border: '2px dashed ' + (dragOverTarget === 'sfx:root' ? '#4caf50' : '#ccc'),
              borderRadius: 8,
              textAlign: 'center',
              cursor: 'pointer',
              transition: 'all 0.2s ease'
            }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverTarget('sfx:root'); }}
            onDragLeave={() => setDragOverTarget(null)}
            onDrop={(e) => {
              e.preventDefault(); setDragOverTarget(null);
              const rel = e.dataTransfer.getData('text/plain'); if (!rel) return; const parts = rel.split('\\'); const filename = parts[parts.length-1]; const target = `soundEffects\\${filename}`; attemptMove(rel, target);
            }}
          >
            <i className="material-icons" style={{ fontSize: 32, color: '#999', display: 'block', marginBottom: 8 }}>upload_file</i>
            <div style={{ color: '#666', fontSize: 13 }}>Drop files/folders here</div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <button className="btn" onClick={() => {
              const modal = window.M.Modal.getInstance(document.getElementById('createFolderModal'));
              setCreateFolderType('sfx');
              setCreateFolderName('');
              modal.open();
            }}><i className="material-icons" style={{ fontSize: 20, marginRight: 4 }}>create_new_folder</i>Create Folder</button>
          </div>
          <div style={{ marginBottom: 8 }}>
        <label>SFX volume: </label>
          <input type="range" min="0" max="2" step="0.05" value={sfxVolume} onChange={async e => {
            const v = Number(e.target.value); setSfxVolume(v);
            if (guildId) {
              try { await axios.post('/api/volume', { guildId, sfxVolume: v }); } catch (e) { /* ignore */ }
            }
          }} style={{ width: 300 }} />
          <span style={{ marginLeft: 8 }}>{sfxVolume.toFixed(2)}</span>
          </div>
          {/* list area is scrollable so header and controls stay visible */}
          <div style={{ overflowY: 'auto', maxHeight: '60vh', paddingRight: 8 }}>
          {/* root drop target moved to header icon */}
          {tracks.soundEffects ? Object.keys(tracks.soundEffects).map(group => (
            <div key={group} style={{ marginTop: 12 }}>
              <h3
                style={{ cursor: 'pointer' }}
                onClick={() => setCollapsed(prev => ({ ...prev, [`sfx:${group}`]: !prev[`sfx:${group}`] }))}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
                onDragEnter={() => setDragOverTarget(`sfx:${group}`)}
                onDragLeave={() => setDragOverTarget(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverTarget(null);
                  const rel = e.dataTransfer.getData('text/plain');
                  if (!rel) return;
                  const filename = rel.split('\\').pop();
                  const target = `soundEffects\\${group}\\${filename}`;
                  setCollapsed(prev => ({ ...prev, [`sfx:${group}`]: false }));
                  attemptMove(rel, target);
                }}
                className={`group-header ${dragOverTarget === ('sfx:' + group) ? 'teal lighten-4' : ''}`}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1 }}>{group}</span>
                  <button
                    className="btn-small teal"
                    onClick={async (e) => {
                      e.stopPropagation();
                      const fileCount = tracks.soundEffects[group].length;
                      const message = fileCount > 0
                        ? `Delete folder "${group}" and ${fileCount} file(s) inside?`
                        : `Delete empty folder "${group}"?`;
                      if (!window.confirm(message)) return;
                      try {
                        await axios.post('/api/delete-folder', { type: 'sfx', folderName: group });
                        setMessage({ success: `Deleted folder ${group}` });
                        await fetchTracks();
                      } catch (e) {
                        setMessage({ error: e.response?.data?.error || e.message });
                      }
                    }}
                    style={{ padding: '0 8px', height: 24, lineHeight: '24px', fontSize: 11 }}
                    title="Delete folder"
                  >
                    <i className="material-icons" style={{ fontSize: 16, color: 'white' }}>delete</i>
                  </button>
                  <i className="material-icons" aria-hidden>{collapsed[`sfx:${group}`] ? 'chevron_right' : 'expand_more'}</i>
                </span>
              </h3>
              {!collapsed[`sfx:${group}`] && (
                <ul onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
                  e.preventDefault();
                  const rel = e.dataTransfer.getData('text/plain');
                  if (!rel) return;
                  const filename = rel.split('\\').pop();
                  const target = `soundEffects\\${group}\\${filename}`;
                  attemptMove(rel, target);
                }}>
                  {tracks.soundEffects[group].length === 0 && (
                    <li style={{ marginTop: 6, fontSize: 13, color: '#999', fontStyle: 'italic' }}>Empty folder</li>
                  )}
                  {tracks.soundEffects[group].map(item => (
                    <li key={item.relPath} className="list-item" style={{ marginTop: 6, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }} draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', item.relPath); e.dataTransfer.setData('source', 'sfx'); }} onClick={() => handleSfx(item)}>
                      <span style={{ flex: 1 }}>{item.name}</span>
                      <button aria-label={`Play full ${item.name}`} className="btn" onClick={(e) => { e.stopPropagation(); handlePlay(item); }} style={{ padding: '0 8px', height: 28 }}>Play (full)</button>
                      <button aria-label={`Play SFX ${item.name}`} className="btn" onClick={(e) => { e.stopPropagation(); handleSfx(item); }} style={{ padding: '0 8px', height: 28 }}>Play SFX</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )) : <div>No sound effects found</div>}
          </div>
  </div>
      </div>

      {/* Modal for creating folders (kept inside root element) */}
      <div id="createFolderModal" className="modal">
        <div className="modal-content">
          <h4>Create Folder</h4>
          <div className="input-field">
            <input id="newFolderName" type="text" value={createFolderName || ''} onChange={e => setCreateFolderName(e.target.value)} />
            <label htmlFor="newFolderName" className={createFolderName ? 'active' : ''}>Folder name</label>
          </div>
          <p>Type: {createFolderType === 'music' ? 'Music' : 'Sound Effects'}</p>
        </div>
        <div className="modal-footer">
          <button className="modal-close btn-flat" onClick={() => {
            const modal = window.M.Modal.getInstance(document.getElementById('createFolderModal'));
            modal.close();
          }}>Cancel</button>
          <button className="btn" onClick={async () => {
            try {
              if (!createFolderName) return setMessage({ error: 'Folder name required' });
              await axios.post('/api/create-folder', { type: createFolderType, folderName: createFolderName });
              setMessage({ success: `Created folder ${createFolderName}` });
              // fetch tracks first to update the UI
              await fetchTracks();
              // then expand the new folder group
              const key = `${createFolderType === 'music' ? 'music' : 'sfx'}:${createFolderName}`;
              setCollapsed(prev => ({ ...prev, [key]: false }));
              const modal = window.M.Modal.getInstance(document.getElementById('createFolderModal'));
              modal.close();
            } catch (e) {
              setMessage({ error: e.response?.data?.error || e.message });
            }
          }}>Create</button>
        </div>
      </div>

      {/* Conflict modal for overwrite/rename/cancel */}
      <div id="conflictModal" className="modal">
        <div className="modal-content">
          <h4>Conflict detected</h4>
          <p>A file named <strong>{conflict?.filename}</strong> already exists at the destination.</p>
          <div className="input-field">
            <input id="renameField" type="text" value={renameInput} onChange={e => setRenameInput(e.target.value)} />
            <label htmlFor="renameField" className={renameInput ? 'active' : ''}>Rename to</label>
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-close btn-flat" onClick={() => {
            const modal = window.M.Modal.getInstance(document.getElementById('conflictModal'));
            modal.close();
            setConflict(null);
          }}>Cancel</button>
          <button className="btn" onClick={async () => {
            // Overwrite
            try {
              if (!conflict) return;
              await moveFile(conflict.fromRel, conflict.toRel, { overwrite: true });
              setMessage({ success: `Overwrote ${conflict.toRel}` });
              setConflict(null);
              const modal = window.M.Modal.getInstance(document.getElementById('conflictModal'));
              modal.close();
            } catch (e) { setMessage({ error: e.response?.data?.error || e.message }); }
          }}>Overwrite</button>
          <button className="btn" style={{ marginLeft: 8 }} onClick={async () => {
            // Rename
            try {
              if (!conflict) return;
              const parts = conflict.toRel.split('\\');
              parts[parts.length - 1] = renameInput || conflict.filename;
              const newTo = parts.join('\\');
              await moveFile(conflict.fromRel, newTo);
              setMessage({ success: `Moved as ${newTo}` });
              setConflict(null);
              const modal = window.M.Modal.getInstance(document.getElementById('conflictModal'));
              modal.close();
            } catch (e) { setMessage({ error: e.response?.data?.error || e.message }); }
          }}>Rename & Move</button>
        </div>
      </div>
      {/* connection summary shown at bottom when joined */}
      {joined && (
        <div className="connection-bottom">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 13 }}>
              Connected to channel: <strong>{channel || 'unknown'}</strong>
            </div>
            <div>
              <button
                className="btn"
                onClick={async () => {
                  if (!guildId) return setMessage({ error: 'guildId required to leave' });
                  try {
                    await axios.post('/api/player', { guildId, action: 'stop' });
                    await axios.post('/api/leave', { guildId });
                    try { if (eventSource) { eventSource.close(); setEventSource(null); } } catch (e) {}
                    setJoined(false);
                    setMessage({ success: 'Left channel' });
                    setNowPlaying('');
                    refreshDiag();
                  } catch (e) {
                    setMessage({ error: e.response?.data?.error || e.message });
                  }
                }}
                disabled={!connectedGuilds.has(guildId)}
                title={!guildId ? 'Select a channel/guild first' : (!connectedGuilds.has(guildId) ? 'Bot is not connected to the selected guild' : 'Leave this guild')}
              >Leave</button>
            </div>
          </div>
        </div>
      )}
      {/* Global footer actions */}
      <div style={{ marginTop: 18, borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 10, display: 'flex', justifyContent: 'center' }}>
        <button className="btn" disabled={disconnecting} onClick={async () => {
          if (!window.confirm('Disconnect the bot from all voice channels? This will stop playback and leave every guild voice channel.')) return;
          setDisconnecting(true);
          try {
            const res = await axios.post('/api/disconnect-all');
            setMessage({ success: `Disconnected from ${res.data.disconnected ? res.data.disconnected.length : 0} guild(s)` });
            // refresh diagnostics to update UI
            setNowPlaying('');
            refreshDiag();
          } catch (e) {
            setMessage({ error: e.response?.data?.error || e.message });
          } finally { setDisconnecting(false); }
        }}>{disconnecting ? 'Disconnecting…' : 'Disconnect from all servers'}</button>
      </div>
    </div>
  );
}

export default App;
