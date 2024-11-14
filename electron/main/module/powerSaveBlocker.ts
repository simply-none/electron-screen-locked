import { powerSaveBlocker } from "electron";
import ElectronStore from "electron-store";

let store = new ElectronStore()
let appId = -1
let displayId = -1

function start (type: 'prevent-app-suspension' | 'prevent-display-sleep' = "prevent-display-sleep") {

  if (store.get(type)) 
  if (type === "prevent-app-suspension") {
    appId = powerSaveBlocker.start("prevent-app-suspension");
    store.set("appId", appId);

  } else if (type === "prevent-display-sleep") {
    displayId = powerSaveBlocker.start("prevent-display-sleep");
  }
  store.set(type, true);
}

function stop (type: 'prevent-app-suspension' | 'prevent-display-sleep' = "prevent-display-sleep") {
  powerSaveBlocker.stop(type === "prevent-app-suspension" ? appId : displayId);
  store.set(type, false);
}

export default { start, stop };
