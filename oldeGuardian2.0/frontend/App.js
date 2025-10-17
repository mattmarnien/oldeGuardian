import React, { useEffect, useState } from 'react';
import axios from 'axios';

function App() {
  const [guildId, setGuildId] = useState('');
  const [channel, setChannel] = useState('');
  const [tracks, setTracks] = useState([]);
  const [message, setMessage] = useState(null);
  const [channels, setChannels] = useState([
    { id: '965874270221787176', label: 'OG DnD', guildId: '491059674095943680' },
    { id: '1113241781660819558', label: 'Hutts n D', guildId: '412088685916323862' },
    { id: '1117264408909983934', label: 'PSU DnD', guildId: '491059674095943680' },
    { id: '975071771147505760', label: 'SCC DnD', guildId: '975071770690330666' },
    { id: '491059674095943684', label: 'OG gen', guildId: '491059674095943680' },
  ]);
  const [newChannelLabel, setNewChannelLabel] = useState('');
  const [newChannelId, setNewChannelId] = useState('');
  const [newChannelGuildId, setNewChannelGuildId] = useState('');

  useEffect(() => {
    fetchTracks();
  }, []);

  const fetchTracks = async () => {
    try {
      const res = await axios.get('/api/tracks');
      // expect { music: { group: [ {name, relPath} ] }, soundEffects: { ... } }
      setTracks(res.data || {});
    } catch (err) {
      setMessage({ error: err.response?.data?.error || err.message });
    }
  };

  const handleJoin = async () => {
    if (!guildId || !channel) return setMessage({ error: 'Guild ID and channel required to join.' });
    try {
      const res = await axios.post('/api/join', { guildId, channel });
      setMessage({ success: `Joined ${res.data.channel}` });
    } catch (err) {
      setMessage({ error: err.response?.data?.error || err.message });
    }
  };

  const handlePlay = async (track) => {
    if (!guildId || !channel) return setMessage({ error: 'Guild ID and channel required to play.' });
    try {
      await axios.post('/api/play', { guildId, channel, track: track.relPath });
      setMessage({ success: `Playing ${track.name}` });
    } catch (err) {
      setMessage({ error: err.response?.data?.error || err.message });
    }
  };

  return (
    <div className="App" style={{ padding: 20 }}>
      <h1>oldeGuardian2.0 — Local Music</h1>
      <div style={{ marginBottom: 10 }}>
        <input placeholder="Guild ID" value={guildId} onChange={e => setGuildId(e.target.value)} />
        <select value={channel} onChange={e => {
          const val = e.target.value;
          setChannel(val);
          const found = channels.find(c => c.id === val);
          if (found) setGuildId(found.guildId || '');
        }} style={{ marginLeft: 8 }}>
          <option value="">-- Select Channel --</option>
          {channels.map(ch => (
            <option key={ch.id} value={ch.id}>{`${ch.label} (${ch.id}) — guild ${ch.guildId || 'N/A'}`}</option>
          ))}
        </select>
        <button onClick={handleJoin} style={{ marginLeft: 8 }}>Join</button>
        <div style={{ display: 'inline-block', marginLeft: 12 }}>
          <input placeholder="Label" value={newChannelLabel} onChange={e => setNewChannelLabel(e.target.value)} style={{ width: 120 }} />
          <input placeholder="Channel ID" value={newChannelId} onChange={e => setNewChannelId(e.target.value)} style={{ width: 200, marginLeft: 6 }} />
          <input placeholder="Guild ID" value={newChannelGuildId} onChange={e => setNewChannelGuildId(e.target.value)} style={{ width: 200, marginLeft: 6 }} />
          <button onClick={() => {
            if (!newChannelId) return setMessage({ error: 'Channel ID required' });
            if (!newChannelGuildId) return setMessage({ error: 'Guild ID required' });
            const lbl = newChannelLabel || newChannelId;
            setChannels(prev => [...prev, { id: newChannelId, label: lbl, guildId: newChannelGuildId }]);
            setNewChannelLabel(''); setNewChannelId(''); setNewChannelGuildId('');
            setMessage({ success: `Added channel ${lbl}` });
          }} style={{ marginLeft: 6 }}>Add</button>
        </div>
      </div>

      {message && (
        <div style={{ color: message.error ? 'red' : 'green', marginBottom: 10 }}>
          {message.error ? `Error: ${message.error}` : message.success}
        </div>
      )}

      <h2>Music</h2>
      <button onClick={fetchTracks}>Refresh</button>
      {tracks.music ? Object.keys(tracks.music).map(group => (
        <div key={group} style={{ marginTop: 12 }}>
          <h3>{group}</h3>
          <ul>
            {tracks.music[group].map(item => (
              <li key={item.relPath} style={{ marginTop: 6 }}>
                {item.name}
                <button onClick={() => handlePlay(item)} style={{ marginLeft: 8 }}>Play</button>
              </li>
            ))}
          </ul>
        </div>
      )) : <div>No music found</div>}

      <h2>Sound Effects</h2>
      {tracks.soundEffects ? Object.keys(tracks.soundEffects).map(group => (
        <div key={group} style={{ marginTop: 12 }}>
          <h3>{group}</h3>
          <ul>
            {tracks.soundEffects[group].map(item => (
              <li key={item.relPath} style={{ marginTop: 6 }}>
                {item.name}
                <button onClick={() => handlePlay(item)} style={{ marginLeft: 8 }}>Play</button>
              </li>
            ))}
          </ul>
        </div>
      )) : <div>No sound effects found</div>}
    </div>
  );
}

export default App;
