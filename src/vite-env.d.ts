/// <reference types="vite/client" />
declare const __EXT_VERSION__: string;
declare module 'opencc-js/cn2t' {
  export function Converter(o: { from: string; to: string }): (s: string) => string;
}
declare const __BUILD__: string;
