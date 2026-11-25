// The import page runs with cross-origin isolation (see vite.config.ts and public/_headers),
// so the AI model can use several CPU threads. It has no YouTube player, which isolation would block.
import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MODELS } from './separate/mdx';
import { decodeFile, MODEL_BASE, ORT_BASE, runWorker } from './separate/client';
import { saveLocal, toInt16 } from './separate/db';
import { settings, useStore } from './core/store';
import './styles.css';

const TEXT = {
  zh: {
    title: '匯入我的歌',
    back: '← 回到 URKTV',
    lead: '選一個音檔或影片檔。AI 會在這台裝置上分離伴奏和原唱，並算出評分用的旋律；檔案不會上傳。',
    pick: '選擇檔案',
    drop: '或把檔案拖到這裡',
    name: '歌名',
    model: '分離方式',
    'model.inst_hq3': '去除全部人聲（推薦）',
    'model.kara2': '只去主唱，保留和聲',
    start: '開始處理',
    decode: '讀取檔案…',
    download: '下載 AI 模型（第一次才需要）… {pct}%',
    load: '載入 AI 模型…',
    separate: '分離人聲… {done}/{total} 段 · 剩約 {eta}',
    notes: '計算旋律…',
    save: '儲存中…',
    done: '完成！{dur} 的歌，處理 {secs} 秒（{backend}），{notes} 個音符。',
    sing: '開始唱',
    another: '再匯入一首',
    fail: '處理失敗：{msg}',
    tooLong: '目前最長支援 10 分鐘的歌。',
    engine: 'CPU 執行緒 {threads}；有顯示卡時自動改用 WebGPU 加速。',
    rights: '請只匯入你有權使用的音檔。',
  },
  en: {
    title: 'Import my song',
    back: '← Back to URKTV',
    lead: 'Choose an audio or video file. The AI separates the backing track and the original vocal on this device and works out the melody for scoring. The file is not uploaded.',
    pick: 'Choose a file',
    drop: 'or drop a file here',
    name: 'Title',
    model: 'Separation',
    'model.inst_hq3': 'Remove all vocals (recommended)',
    'model.kara2': 'Remove the lead vocal, keep backing vocals',
    start: 'Start',
    decode: 'Reading the file…',
    download: 'Downloading the AI model (first time only)… {pct}%',
    load: 'Loading the AI model…',
    separate: 'Separating the vocal… part {done}/{total} · about {eta} left',
    notes: 'Working out the melody…',
    save: 'Saving…',
    done: 'Done! A {dur} song, processed in {secs} s ({backend}), {notes} notes.',
    sing: 'Sing it',
    another: 'Import another',
    fail: 'Processing failed: {msg}',
    tooLong: 'Songs up to 10 minutes are supported for now.',
    engine: 'CPU threads {threads}; a graphics card is used automatically (WebGPU) when there is one.',
    rights: 'Only import files you have the right to use.',
  },
};

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function ImportPage() {
  const lang = useStore(settings).lang;
  const T = TEXT[lang];
  const tr = (k: keyof typeof T, v: Record<string, string | number> = {}) =>
    Object.entries(v).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), T[k] as string);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [model, setModel] = useState<'inst_hq3' | 'kara2'>('inst_hq3');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [doneId, setDoneId] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const choose = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setName(f.name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim());
    setErr('');
    setDoneId('');
  };

  const go = async () => {
    if (!file) return;
    setBusy(true);
    setErr('');
    setDoneId('');
    try {
      setStatus(T.decode);
      const [left, right] = await decodeFile(file);
      const dur = left.length / 44100;
      if (dur > 600) throw new Error(T.tooLong);
      const cfg = MODELS[model];
      const t0 = performance.now();
      let firstChunkAt = 0;
      const job = runWorker(
        { type: 'separate', left, right, model, modelUrl: MODEL_BASE + cfg.file, ortBase: ORT_BASE },
        (p) => {
          if (p.stage === 'download') setStatus(tr('download', { pct: p.total ? Math.round((100 * p.done) / p.total) : '…' }));
          else if (p.stage === 'load') setStatus(T.load);
          else if (p.stage === 'separate') {
            if (p.done === 1) firstChunkAt = performance.now();
            const per = p.done > 1 ? (performance.now() - firstChunkAt) / (p.done - 1) : (performance.now() - t0) / p.done;
            setStatus(tr('separate', { done: p.done, total: p.total, eta: fmt(((p.total - p.done) * per) / 1000) }));
          } else if (p.stage === 'notes') setStatus(T.notes);
        },
        [left.buffer, right.buffer],
      );
      const out = await job.done;
      if (out.type !== 'separated') throw new Error('unexpected reply');
      setStatus(T.save);
      const id = 'local:' + (crypto.randomUUID?.() ?? String(Date.now()));
      // keep the guide vocal mono: half the space, and it is only a guide
      const v = out.vocals;
      const mono = new Float32Array(v[0].length);
      for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (v[0][i] + v[1][i]);
      await saveLocal({
        id,
        title: name.trim() || file.name,
        createdAt: Date.now(),
        duration: dur,
        noteCount: out.notes.length,
        model,
        sampleRate: 44100,
        notes: out.notes,
        lines: out.lines,
        inst: toInt16(out.instrumental),
        voc: toInt16([mono]),
      });
      setStatus(tr('done', { dur: fmt(dur), secs: Math.round(out.seconds), backend: out.backend, notes: out.notes.length }));
      setDoneId(id);
    } catch (e: any) {
      setErr(tr('fail', { msg: e?.message ?? String(e) }));
      setStatus('');
    } finally {
      setBusy(false);
    }
  };

  const threads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  return (
    <div className="shell">
      <header className="topbar">
        <a className="btn ghost" href="index.html#mine">
          {T.back}
        </a>
      </header>
      <main className="page narrow">
        <section>
          <h1 className="import-title">{T.title}</h1>
          <p className="lead">{T.lead}</p>
        </section>
        <div
          className={'card drop' + (file ? ' has' : '')}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            choose(e.dataTransfer.files?.[0]);
          }}
        >
          <input ref={fileRef} type="file" accept="audio/*,video/*" hidden onChange={(e) => choose(e.target.files?.[0])} />
          <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            {T.pick}
          </button>
          <span className="muted">{file ? file.name : T.drop}</span>
        </div>
        {file && (
          <div className="card col">
            <label className="field">
              <span>{T.name}</span>
              <input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>{T.model}</span>
              <select value={model} disabled={busy} onChange={(e) => setModel(e.target.value as 'inst_hq3' | 'kara2')}>
                <option value="inst_hq3">{T['model.inst_hq3']}</option>
                <option value="kara2">{T['model.kara2']}</option>
              </select>
            </label>
            <button className="btn primary" disabled={busy} onClick={go}>
              {T.start}
            </button>
            <p className="muted small">{T.rights}</p>
          </div>
        )}
        {status && (
          <p className={'notice ' + (doneId ? 'ok' : '')} role="status">
            {status}
          </p>
        )}
        {err && <p className="notice warn">{err}</p>}
        {doneId && (
          <div className="row">
            <a className="btn primary" href={`index.html#sing=${encodeURIComponent(doneId)}`}>
              🎤 {T.sing}
            </a>
            <button
              className="btn"
              onClick={() => {
                setFile(null);
                setDoneId('');
                setStatus('');
              }}
            >
              {T.another}
            </button>
          </div>
        )}
        <p className="muted small">{tr('engine', { threads })}</p>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ImportPage />
  </StrictMode>,
);
