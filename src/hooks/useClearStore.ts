import { sysNotify } from "../utils/notify";
import confirmDialog from "../utils/confirmDialog";

export default function useClearStore() {

  function clearStore() {
    confirmDialog.open('是否需要删除数据', () => {
      const msg = window.ipcRenderer.sendSync('clear-store');
      sysNotify('提示', msg);
      console.warn('store cleared: ', msg);
    }, () => {})
  }
  return {
    clearStore
  };
};