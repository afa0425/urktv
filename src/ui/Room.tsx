// Sing together / watch live. The room server keeps members, the song queue, a shared clock and chat.
// Every member plays the MV on their own YouTube player, in step with the clock (never re-streamed);
// the singer's voice and anyone's camera go browser to browser (WebRTC).
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseVideoId, thumbUrl, YouTubeTransport } from '../core/transport';

interface Member {
  id: string;
  name: string;
  role: 'sing' | 'watch';
  cam: boolean;
}
interface QItem {
  videoId: string;
  title: string;
  by: string;
  byName: string;
}
interface NowSong extends QItem {
  singer: string;
  singerName: string;
  startAt: number;
  pausedAt: number | null;
}
interface Chat {
  from: string;
  text: string;
  at: number;
}

const ICE: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };
/** Listeners play the MV this much later than the clock, so the singer's voice (sent over the
 *  network) lands on the beat. */
const VOICE_DELAY = 0.35;
const REACTS = ['👏', '🔥', '❤️', '😂', '🎉', '🌹', '👍', '🥹'];

export const newRoomCode = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');

export function RoomPage({ code, onExit }: { code: string; onExit(): void }) {
  const [joined, setJoined] = useState<{ name: string; role: 'sing' | 'watch'; cam: boolean } | null>(null);
  if (!joined) return <Lobby code={code} onJoin={setJoined} onExit={onExit} />;
  return <RoomLive code={code} me={joined} onExit={onExit} />;
}

function Lobby({ code, onJoin, onExit }: { code: string; onJoin(j: { name: string; role: 'sing' | 'watch'; cam: boolean }): void; onExit(): void }) {
  const [name, setName] = useState(() => localStorage.getItem('urktv.name') || '');
  const [role, setRole] = useState<'sing' | 'watch'>('sing');
  const [cam, setCam] = useState(false);
  const link = `${location.origin}${location.pathname}#room=${code}`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="page room-lobby">
      <button className="btn ghost" onClick={onExit}>
        ← 離開
      </button>
      <div className="lobby-card">
        <div className="h-neon small-neon">
          ROOM <span>{code}</span>
        </div>
        <p className="muted">把連結傳給朋友，一起唱、一起看</p>
        <div className="row wrap center">
          <code className="room-link">{link}</code>
          <button
            className="btn small"
            onClick={() => {
              void navigator.clipboard.writeText(link).then(() => setCopied(true));
            }}
          >
            {copied ? '已複製 ✓' : '複製連結'}
          </button>
        </div>
        <label className="field">
          <span>你的名字</span>
          <input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="例如：小明" />
        </label>
        <div className="seg big" role="radiogroup">
          <button role="radio" aria-checked={role === 'sing'} className={'seg-btn' + (role === 'sing' ? ' on' : '')} onClick={() => setRole('sing')}>
            🎤 我要唱
          </button>
          <button role="radio" aria-checked={role === 'watch'} className={'seg-btn' + (role === 'watch' ? ' on' : '')} onClick={() => setRole('watch')}>
            👀 我是觀眾
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={cam} onChange={(e) => setCam(e.target.checked)} /> 📷 開鏡頭（可以之後再開）
        </label>
        <button
          className="btn primary big"
          onClick={() => {
            const n = name.trim() || (role === 'sing' ? '歌手' : '觀眾');
            localStorage.setItem('urktv.name', n);
            onJoin({ name: n, role, cam });
          }}
        >
          進入房間
        </button>
        <p className="muted small">唱歌的人建議戴耳機，朋友才不會聽到兩次 MV。</p>
      </div>
    </div>
  );
}

function RoomLive({ code, me, onExit }: { code: string; me: { name: string; role: 'sing' | 'watch'; cam: boolean }; onExit(): void }) {
  const [myId, setMyId] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [queue, setQueue] = useState<QItem[]>([]);
  const [now, setNow] = useState<NowSong | null>(null);
  const [chat, setChat] = useState<Chat[]>([]);
  const [floats, setFloats] = useState<{ id: number; emoji: string; x: number }[]>([]);
  const [status, setStatus] = useState('連線中…');
  const [link, setLink] = useState('');
  const [text, setText] = useState('');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(me.cam);
  const [tiles, setTiles] = useState<Record<string, MediaStream>>({});
  const [countdown, setCountdown] = useState(0);
  const ws = useRef<WebSocket | null>(null);
  const offset = useRef(0); // server clock - local clock
  const local = useRef<MediaStream | null>(null);
  const peers = useRef(new Map<string, RTCPeerConnection>());
  const hostRef = useRef<HTMLDivElement>(null);
  const player = useRef<YouTubeTransport | null>(null);
  const playerVid = useRef('');
  const nowRef = useRef(now);
  nowRef.current = now;
  const myIdRef = useRef('');
  const floatId = useRef(0);
  const making = useRef(new Set<string>());

  const send = (m: object) => ws.current?.readyState === 1 && ws.current.send(JSON.stringify(m));
  const serverNow = () => Date.now() + offset.current;
  const iSing = !!now && now.singer === myId;

  // my microphone (singers) and camera
  useEffect(() => {
    let stop = false;
    const want = { audio: me.role === 'sing' ? { echoCancellation: true, noiseSuppression: false, autoGainControl: false } : false, video: camOn ? { width: 320, height: 240 } : false };
    if (!want.audio && !want.video) {
      local.current?.getTracks().forEach((t) => t.stop());
      local.current = null;
      setTiles((t) => {
        const { me: _gone, ...rest } = t;
        return rest;
      });
      return;
    }
    navigator.mediaDevices
      .getUserMedia(want as MediaStreamConstraints)
      .then((s) => {
        if (stop) return s.getTracks().forEach((t) => t.stop());
        local.current?.getTracks().forEach((t) => t.stop());
        local.current = s;
        s.getAudioTracks().forEach((t) => (t.enabled = false)); // on only while it is my turn
        if (s.getVideoTracks().length) setTiles((t) => ({ ...t, me: s }));
        // send the new tracks to everyone already connected
        for (const pc of peers.current.values()) {
          for (const tr of s.getTracks()) {
            const sender = pc.getSenders().find((x) => x.track?.kind === tr.kind);
            if (sender) void sender.replaceTrack(tr);
            else pc.addTrack(tr, s);
          }
        }
      })
      .catch(() => setStatus('沒有麥克風或鏡頭權限：還是可以看和聊天'));
    send({ type: 'cam', on: camOn });
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camOn]);

  // mic is live only for the current singer
  useEffect(() => {
    local.current?.getAudioTracks().forEach((t) => (t.enabled = iSing && micOn));
  }, [iSing, micOn, now]);

  const peer = (id: string) => {
    let pc = peers.current.get(id);
    if (pc) return pc;
    pc = new RTCPeerConnection(ICE);
    peers.current.set(id, pc);
    local.current?.getTracks().forEach((t) => pc!.addTrack(t, local.current!));
    // receive even when I send nothing (watchers)
    if (!local.current?.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'recvonly' });
    if (!local.current?.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
    pc.onicecandidate = (e) => e.candidate && send({ type: 'signal', to: id, data: { ice: e.candidate } });
    // tracks added later (camera on, mic granted) renegotiate; collisions are settled by id order
    pc.onnegotiationneeded = async () => {
      try {
        making.current.add(id);
        await pc!.setLocalDescription();
        send({ type: 'signal', to: id, data: { sdp: pc!.localDescription } });
      } finally {
        making.current.delete(id);
      }
    };
    pc.ontrack = (e) => {
      const s = e.streams[0] ?? new MediaStream([e.track]);
      setTiles((t) => ({ ...t, [id]: s }));
    };
    pc.onconnectionstatechange = () => {
      if (pc!.connectionState === 'failed' || pc!.connectionState === 'closed') {
        peers.current.delete(id);
        setTiles((t) => {
          const { [id]: _gone, ...rest } = t;
          return rest;
        });
      }
    };
    return pc;
  };

  const call = (id: string) => void peer(id); // creating it adds tracks: negotiation starts by itself

  const onSignal = async (from: string, data: any) => {
    const pc = peer(from);
    if (data.sdp) {
      const collision = data.sdp.type === 'offer' && (making.current.has(from) || pc.signalingState !== 'stable');
      const polite = myIdRef.current > from;
      if (collision && !polite) return; // the other side yields
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription();
        send({ type: 'signal', to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.ice) {
      try {
        await pc.addIceCandidate(data.ice);
      } catch {
        /* late candidate */
      }
    }
  };

  // the room connection
  useEffect(() => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/room/${code}`;
    let closed = false;
    let retry = 0;
    const open = () => {
      const s = new WebSocket(url);
      ws.current = s;
      s.onopen = () => {
        retry = 0;
        setStatus('');
        s.send(JSON.stringify({ type: 'join', name: me.name, role: me.role, cam: camOn }));
        const t0 = Date.now();
        s.send(JSON.stringify({ type: 'ping', t0 }));
      };
      s.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'hello') {
          setMyId(m.id);
          myIdRef.current = m.id;
          offset.current = m.server - Date.now();
        } else if (m.type === 'pong') {
          const t1 = Date.now();
          offset.current = m.server - (m.t0 + t1) / 2;
        } else if (m.type === 'state') {
          setMembers(m.members);
          setQueue(m.queue);
          setNow(m.now);
          // connect to everyone new: the member with the smaller id calls
          for (const mem of m.members as Member[]) {
            if (mem.id !== myIdRef.current && !peers.current.has(mem.id) && myIdRef.current < mem.id) call(mem.id);
          }
        } else if (m.type === 'left') {
          peers.current.get(m.id)?.close();
          peers.current.delete(m.id);
          setTiles((t) => {
            const { [m.id]: _gone, ...rest } = t;
            return rest;
          });
        } else if (m.type === 'signal') void onSignal(m.from, m.data);
        else if (m.type === 'chatlog') setChat(m.chat);
        else if (m.type === 'chat') setChat((c) => [...c.slice(-49), m]);
        else if (m.type === 'react') {
          const id = ++floatId.current;
          setFloats((f) => [...f.slice(-30), { id, emoji: m.emoji, x: 10 + Math.random() * 80 }]);
          setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 2600);
        } else if (m.type === 'full') setStatus('房間滿了（最多 30 人）');
      };
      s.onclose = () => {
        if (closed) return;
        setStatus('連線中斷，重新連線…');
        for (const pc of peers.current.values()) pc.close();
        peers.current.clear();
        setTimeout(open, Math.min(8000, 1000 * 2 ** retry++));
      };
    };
    open();
    const ping = window.setInterval(() => send({ type: 'ping', t0: Date.now() }), 15000);
    return () => {
      closed = true;
      window.clearInterval(ping);
      ws.current?.close();
      for (const pc of peers.current.values()) pc.close();
      peers.current.clear();
      local.current?.getTracks().forEach((t) => t.stop());
      player.current?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // the MV: everyone's own player, kept on the room clock
  useEffect(() => {
    const id = window.setInterval(() => {
      const n = nowRef.current;
      if (!n) {
        if (player.current) {
          player.current.destroy();
          player.current = null;
          playerVid.current = '';
          hostRef.current?.replaceChildren();
        }
        setCountdown(0);
        return;
      }
      if (playerVid.current !== n.videoId) {
        player.current?.destroy();
        hostRef.current?.replaceChildren();
        playerVid.current = n.videoId;
        player.current = new YouTubeTransport(hostRef.current!, n.videoId, {});
      }
      const p = player.current!;
      const singer = n.singer === myIdRef.current;
      const target = n.pausedAt ?? (serverNow() - n.startAt) / 1000 - (singer ? 0 : VOICE_DELAY);
      if (target < 0) {
        setCountdown(Math.ceil(-target));
        if (p.playing()) p.pause();
        return;
      }
      setCountdown(0);
      if (n.pausedAt !== null) {
        if (p.playing()) p.pause();
        if (Math.abs(p.time() - target) > 0.5) p.seek(target);
        return;
      }
      if (!p.playing()) {
        p.seek(target);
        p.play();
      } else if (Math.abs(p.time() - target) > 0.8) p.seek(target);
      if (singer && p.ended()) send({ type: 'ended' });
    }, 400);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addSong = () => {
    const vid = parseVideoId(link);
    if (!vid) return setStatus('請貼 YouTube 連結');
    send({ type: 'queue', videoId: vid, title: `YouTube · ${vid}` });
    setLink('');
    setStatus('');
  };
  const singers = members.filter((m) => m.role === 'sing');
  const watchers = members.filter((m) => m.role === 'watch');
  const nameOf = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const shareLink = `${location.origin}${location.pathname}#room=${code}`;

  return (
    <div className="stage neon room">
      <div className="beams" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <header className="stage-top">
        <button className="btn ghost" onClick={onExit}>
          ← 離開
        </button>
        <h1 className="stage-title">
          🎉 房間 {code} <span className="live-dot">LIVE</span>
        </h1>
        <span className="chip">👀 {watchers.length} 觀眾 · 🎤 {singers.length} 歌手</span>
        <button className="btn small" onClick={() => void navigator.clipboard.writeText(shareLink)}>
          邀請朋友
        </button>
      </header>
      {status && <p className="notice warn">{status}</p>}
      <div className="stage-grid">
        <section className="stage-main">
          <div className="video">
            <div className="video-host" ref={hostRef} />
            {!now && (
              <div className="overlay">
                <p className="prep-label">還沒有人點歌</p>
                <p className="muted">在右邊貼 YouTube 連結點一首，輪到你就開唱</p>
              </div>
            )}
            {now && countdown > 0 && (
              <div className="overlay prep">
                <p className="prep-label">
                  {now.singer === myId ? '輪到你了！' : `${now.singerName} 準備開唱`}
                </p>
                <div className="room-count">{countdown}</div>
              </div>
            )}
            <div className="floats" aria-hidden="true">
              {floats.map((f) => (
                <span key={f.id} style={{ left: `${f.x}%` }}>
                  {f.emoji}
                </span>
              ))}
            </div>
          </div>
          <div className="stage-bar room-bar">
            {now ? (
              <span className="room-now">
                🎤 <b>{now.singerName}</b> 正在唱
              </span>
            ) : (
              <span className="muted">等待點歌</span>
            )}
            {iSing && (
              <>
                <button className="btn small" onClick={() => send({ type: now!.pausedAt === null ? 'pause' : 'resume' })}>
                  {now!.pausedAt === null ? '⏸ 暫停' : '▶ 繼續'}
                </button>
                <button className={'btn small' + (micOn ? ' primary' : '')} onClick={() => setMicOn((m) => !m)}>
                  {micOn ? '🎙️ 麥克風開' : '🔇 麥克風關'}
                </button>
                <button className="btn small" onClick={() => send({ type: 'next' })}>
                  ⏭ 唱完了
                </button>
              </>
            )}
            <span className="spacer" />
            {REACTS.map((e) => (
              <button key={e} className="react-btn" onClick={() => send({ type: 'react', emoji: e })} aria-label={'送出 ' + e}>
                {e}
              </button>
            ))}
          </div>
          <div className="tiles-row">
            {Object.entries(tiles).map(([id, s]) => (
              <Tile key={id} stream={s} name={id === 'me' ? me.name + '（你）' : nameOf.get(id) ?? ''} self={id === 'me'} singing={!!now && (id === now.singer || (id === 'me' && iSing))} />
            ))}
            <button className="btn small cam-btn" onClick={() => setCamOn((c) => !c)}>
              {camOn ? '📷 關鏡頭' : '📷 開鏡頭'}
            </button>
          </div>
        </section>
        <aside className="stage-side">
          <div className="card col">
            <div className="label">點歌</div>
            <div className="row">
              <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="貼 YouTube 連結" onKeyDown={(e) => e.key === 'Enter' && addSong()} />
              <button className="btn primary small" onClick={addSong} disabled={me.role !== 'sing'} title={me.role !== 'sing' ? '觀眾不能點歌' : ''}>
                點歌
              </button>
            </div>
            <ol className="room-queue">
              {queue.map((q, i) => (
                <li key={i}>
                  <img src={thumbUrl(q.videoId)} alt="" />
                  <span>
                    <b>{q.byName}</b>
                    <small className="muted">{q.title}</small>
                  </span>
                  {(q.by === myId || iSing) && (
                    <button className="btn link small" onClick={() => send({ type: 'unqueue', index: i })}>
                      ✕
                    </button>
                  )}
                </li>
              ))}
              {!queue.length && <li className="muted small">還沒有下一首</li>}
            </ol>
          </div>
          <div className="card col chat-card">
            <div className="label">聊天室</div>
            <div className="chat-list">
              {chat.map((c, i) => (
                <p key={i}>
                  <b>{c.from}</b> {c.text}
                </p>
              ))}
            </div>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) send({ type: 'chat', text });
                setText('');
              }}
            >
              <input value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder="說點什麼…" />
              <button className="btn small">送出</button>
            </form>
          </div>
          <div className="card col">
            <div className="label">在房間裡</div>
            <ul className="member-list">
              {members.map((m) => (
                <li key={m.id}>
                  {m.role === 'sing' ? '🎤' : '👀'} {m.name}
                  {m.id === myId ? '（你）' : ''}
                  {now?.singer === m.id ? ' · 唱歌中' : ''}
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** A camera / voice tile; the voice plays through a hidden audio element. */
function Tile({ stream, name, self, singing }: { stream: MediaStream; name: string; self: boolean; singing: boolean }) {
  const v = useRef<HTMLVideoElement>(null);
  const a = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (v.current) v.current.srcObject = stream;
    if (a.current && !self) {
      a.current.srcObject = stream;
      void a.current.play().catch(() => {});
    }
  }, [stream, self]);
  const hasVideo = stream.getVideoTracks().length > 0;
  return (
    <div className={'tile-cam' + (singing ? ' singing' : '')}>
      {hasVideo ? <video ref={v} autoPlay playsInline muted /> : <div className="tile-avatar">🎤</div>}
      {!self && <audio ref={a} autoPlay />}
      <span>{name}</span>
    </div>
  );
}
