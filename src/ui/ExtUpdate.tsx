import { EXT_LATEST, extOutdated, useExtension } from '../core/extension';

/** Tells the singer their extension is old, with the way to update. Nothing when it is current. */
export function ExtUpdate() {
  const ext = useExtension();
  if (!ext.present || !extOutdated(ext.version)) return null;
  return (
    <div className="notice warn ext-update">
      ⚠️ 你的擴充功能是 <b>v{ext.version}</b>，還沒更新到最新 <b>v{EXT_LATEST}</b>，伴奏可能有問題。
      <a className="btn small primary" href="extension.html" target="_blank" rel="noopener">
        去更新
      </a>
    </div>
  );
}
