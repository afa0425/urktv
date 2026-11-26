import { useEffect, useState } from 'react';

/** A newer version of the site is out: say so, one tap reloads (no stale page from a cache). */
export function NewVersion() {
  const [newer, setNewer] = useState(false);
  useEffect(() => {
    const check = () =>
      fetch(new URL('build.txt', document.baseURI).href, { cache: 'no-store' })
        .then((r) => (r.ok ? r.text() : ''))
        .then((b) => b.trim() && b.trim() !== __BUILD__ && setNewer(true))
        .catch(() => {});
    void check();
    const id = window.setInterval(check, 3 * 60 * 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!newer) return null;
  return (
    <button className="new-version" onClick={() => location.reload()}>
      ✨ 網站有新版本了，按這裡更新
    </button>
  );
}
