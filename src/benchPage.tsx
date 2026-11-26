// Speed test: how fast can this computer remove vocals in the browser? Decides which model the
// real-time mode can use. Runs on a 30-second CC-BY clip; nothing is uploaded.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MODELS } from './separate/mdx';
import { MODEL_BASE, ORT_BASE, runWorker } from './separate/client';
import './styles.css';

type Row = { model: string; label: string; status: string; backend?: string; secs?: number; x?: number; download?: number };

const CANDIDATES = ['kara2', 'inst_hq3'] as const;

async function adapterName(gpu: any, pref: 'high-performance' | 'low-power'): Promise<string> {
  const a = await gpu.requestAdapter({ powerPreference: pref });
  if (!a) return '無';
  const i = a.info || (a.requestAdapterInfo ? await a.requestAdapterInfo() : {});
  return [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' · ') || '（未提供型號）';
}

/** Both adapters: on two-GPU machines Chrome may still hand out the built-in one. */
async function gpuInfo(): Promise<string> {
  const gpu = (navigator as any).gpu;
  if (!gpu) return '不支援 WebGPU（會改用 CPU）';
  try {
    const hi = await adapterName(gpu, 'high-performance');
    const lo = await adapterName(gpu, 'low-power');
    return hi === lo ? hi : `高效能：${hi}／省電：${lo}`;
  } catch {
    return '無法取得顯示卡資訊';
  }
}

function verdict(x?: number): string {
  if (x === undefined) return '';
  if (x >= 1.5) return '✅ 可即時（夠快）';
  if (x >= 1.05) return '⚠️ 勉強可即時';
  return '❌ 跟不上，需要較輕的模型';
}

async function decodeClip(): Promise<[Float32Array, Float32Array]> {
  const data = await (await fetch(new URL('bench/clip.mp3', document.baseURI).href)).arrayBuffer();
  const tmp = new AudioContext();
  const buf = await tmp.decodeAudioData(data);
  void tmp.close();
  const off = new OfflineAudioContext(2, Math.ceil(buf.duration * 44100), 44100);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const r = await off.startRendering();
  return [r.getChannelData(0).slice(), r.getChannelData(1).slice()];
}

function Bench() {
  const [gpu, setGpu] = useState('');
  const [rows, setRows] = useState<Row[]>(CANDIDATES.map((m) => ({ model: m, label: MODELS[m].label, status: '等待' })));
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const threads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 2) : 1;

  const set = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r)));

  const go = async () => {
    setBusy(true);
    setGpu(await gpuInfo());
    const [L, R] = await decodeClip();
    const dur = L.length / 44100;
    for (let i = 0; i < CANDIDATES.length; i++) {
      const m = CANDIDATES[i];
      set(i, { status: '下載模型…' });
      const t0 = performance.now();
      let tDownloaded = 0;
      try {
        const out = await runWorker(
          { type: 'separate', left: L.slice(), right: R.slice(), model: m, modelUrl: MODEL_BASE + MODELS[m].file, ortBase: ORT_BASE },
          (p) => {
            if (p.stage === 'download') set(i, { status: `下載模型 ${p.total ? Math.round((100 * p.done) / p.total) : 0}%` });
            else if (p.stage === 'load') {
              tDownloaded = performance.now();
              set(i, { status: '載入模型…' });
            } else if (p.stage === 'separate') set(i, { status: `運算中 ${p.done}/${p.total}`, backend: p.info });
          },
        ).done;
        if (out.type !== 'separated') throw new Error('unexpected');
        const x = dur / out.seconds;
        set(i, { status: '完成', backend: out.backend, secs: out.seconds, x, download: tDownloaded ? (tDownloaded - t0) / 1000 : undefined });
      } catch (e: any) {
        set(i, { status: '失敗：' + (e?.message ?? e) });
      }
    }
    setBusy(false);
  };

  const text = () =>
    [
      `URKTV 測速 ${new Date().toLocaleString()}`,
      `顯示卡：${gpu}`,
      `CPU 執行緒：${threads}，瀏覽器：${navigator.userAgent}`,
      ...rows.map((r) => `${r.label}：${r.x ? r.x.toFixed(2) + ' 倍即時' : r.status}（${r.backend ?? '-'}，30 秒片段算了 ${r.secs?.toFixed(1) ?? '-'} 秒）`),
    ].join('\n');

  return (
    <div className="shell">
      <header className="topbar">
        <a className="btn ghost" href="index.html">← 回到 URKTV</a>
      </header>
      <main className="page narrow">
        <section>
          <h1 className="import-title">去人聲測速</h1>
          <p className="lead">
            測這台電腦在瀏覽器裡去人聲有多快，決定即時模式能用哪個模型。用一段 30 秒的開放授權歌曲，第一次要下載模型（約 120MB），聲音不會上傳。
          </p>
        </section>
        <button className="btn primary big" disabled={busy} onClick={go}>
          {busy ? '測試中…' : '開始測速'}
        </button>
        {gpu && <p className="muted small">顯示卡：{gpu}　CPU 執行緒：{threads}</p>}
        {/amd|intel/i.test(gpu) && !/nvidia/i.test(gpu) && (
          <p className="notice warn">
            瀏覽器用的不是 NVIDIA 顯示卡。請到 Windows「設定 → 系統 → 顯示器 → 圖形」，把 Google Chrome 設成「高效能」（選 NVIDIA），完全關閉 Chrome 再打開，重新測一次。
          </p>
        )}
        <div className="card col">
          {rows.map((r) => (
            <div key={r.model} className="row between wrap">
              <strong>{r.label}</strong>
              <span className="muted small">{r.status}{r.backend ? `（${r.backend}）` : ''}</span>
              <span>{r.x ? `${r.x.toFixed(2)} 倍即時　${verdict(r.x)}` : ''}</span>
            </div>
          ))}
        </div>
        {rows.some((r) => r.x || r.status.startsWith('失敗')) && !busy && (
          <button
            className="btn"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text());
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? '已複製，貼給 Claude' : '複製結果'}
          </button>
        )}
        <p className="muted small">測試音樂：Let's Go Fishin' – Karissa Hobbs（CC BY 3.0）</p>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Bench />
  </StrictMode>,
);
