// What the stage says while you sing: many wordings and symbols, picked at random, never the same
// twice in a row. Only about what you just did; no made-up comparisons with other people.

const pools = {
  combo: [
    '🔥 連擊 ×{n}！停不下來', '⚡ ×{n} 連擊！手感來了', '🎯 連中 {n} 個！', '💫 ×{n}！這就是實力', '🚀 連擊 ×{n}！起飛',
    '🌟 {n} 連擊！全場安靜聽你唱', '💥 ×{n}！神準', '🎶 連續 {n} 個都在音上', '👑 ×{n} 連擊！麥霸模式', '🌈 {n} 連！穩到不行',
  ],
  line: [
    '✨ 這句好聽！', '🎧 有味道！', '💎 這句可以收錄了', '🎤 像原唱一樣！', '🌸 好溫柔', '😎 帥！', '🥹 唱進心裡了',
    '🎼 音準滿分', '🌊 好有感覺', '🍯 好甜的聲音', '👏 漂亮！', '🔊 聲音好亮', '💖 喜歡這句', '🫶 唱得真好',
  ],
  high: ['🔥 高音達成！', '🚀 衝上去了！', '⚡ 這個高音太狂', '🌋 爆發！', '🦅 飛起來了', '💥 高音穩穩的', '👑 高音王者', '✨ 頂上去了！'],
  higher: ['🔼 再高一點點', '⬆️ 往上一點就完美', '☝️ 差一點點，再高一些', '🎯 稍微抬高就中了'],
  lower: ['🔽 再低一點點', '⬇️ 往下一點就完美', '👇 差一點點，再低一些', '🎯 稍微壓低就中了'],
  countdown: ['🔥 高音來了', '⚡ 準備衝', '🚀 要飛了', '💥 大的要來了', '🌋 爆發點', '👑 王者高音'],
  go: ['衝！', '上！', '飛！', '就是現在！', '放開唱！'],
};
export type CheerKind = keyof typeof pools;

const last = new Map<CheerKind, number>();
/** A random wording for this moment, with {n} filled in. */
export function cheer(kind: CheerKind, n = 0): string {
  const list = pools[kind];
  let i = Math.floor(Math.random() * list.length);
  if (list.length > 1 && i === last.get(kind)) i = (i + 1) % list.length;
  last.set(kind, i);
  return list[i].replace('{n}', String(n));
}

/** The countdown wording for one high note stays the same while it counts (no flicker). */
const fixed = new Map<number, number>();
export function countdownWord(key: number): string {
  if (!fixed.has(key)) {
    fixed.set(key, Math.floor(Math.random() * pools.countdown.length));
    if (fixed.size > 200) fixed.clear();
  }
  return pools.countdown[fixed.get(key)!];
}
export function goWord(key: number): string {
  return pools.go[key % pools.go.length];
}
