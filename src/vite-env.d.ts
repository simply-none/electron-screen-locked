/// <reference types="vite/client" />
/// <reference types="vite-plugin-jsonx/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

interface Window {
  // expose in the `electron/preload/index.ts`
  ipcRenderer: import('electron').IpcRenderer
}

type ShowContentType = { error: boolean }

