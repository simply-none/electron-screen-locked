import { ipcMain } from "electron";
import ElectronStore from "electron-store";
import { queryByConditions, upsertData } from "../utils/sql.ts";
import { myDb } from "./newSql.ts";
import colors from "colors";

// 使用nodejs原生crypto模块进行加密，解密
export let store = new ElectronStore();

export const tableName = "basic_info";
// 设备绑定主密钥（vault/deviceKey.ts 写入 electron-store），属敏感密钥，需从调试视图隐藏
// 并在 replace-store / clear-store 时保留，避免被误清空导致已加密保险库无法解密。
// 旧架构遗留的 RSAKey / password 已随 legacy crypto.ts 移除，不再隐藏。
const disabledShowKeys = ["_device_master_key"];

// 获取所有的store数据，同时过滤掉disabledShowKeys中的key
export function getAllStore(): ObjectType {
  let storeData: ObjectType = store.store;
  const keys = Object.keys(storeData || {});
  const newStoreData: ObjectType = {};
  keys.forEach((item) => {
    if (!disabledShowKeys.includes(item)) {
      newStoreData[item] = storeData[item];
    }
  });
  return newStoreData;
}

// 获取disabledShowKeys中的数据
function getDisabledShowKeysData(): ObjectType {
  let storeData: ObjectType = store.store;
  const keys = Object.keys(storeData || {});
  const newStoreData: ObjectType = {};
  keys.forEach((item) => {
    if (disabledShowKeys.includes(item)) {
      newStoreData[item] = storeData[item];
    }
  });
  return newStoreData;
}

export interface PomodoroStatus {
  isResting: boolean
  startWorkTime: number
  closeWorkTime: number
}

export async function getPomodoroStatus(): Promise<PomodoroStatus> {
  return new Promise((resolve) => {
    queryByConditions({
      db: myDb.db,
      tableName: tableName,
      conditions: { key: 'startWorkTime' },
      callback: (err, startData) => {
        if (err) {
          resolve({ isResting: false, startWorkTime: Date.now(), closeWorkTime: Date.now() })
          return
        }

        const startWorkTime = startData.length > 0 ? JSON.parse(startData[0].value) : Date.now()

        queryByConditions({
          db: myDb.db,
          tableName: tableName,
          conditions: { key: 'closeWorkTime' },
          callback: (err, closeData) => {
            if (err) {
              resolve({ isResting: false, startWorkTime, closeWorkTime: Date.now() })
              return
            }

            const closeWorkTime = closeData.length > 0 ? JSON.parse(closeData[0].value) : Date.now()
            const isResting = startWorkTime < closeWorkTime

            resolve({ isResting, startWorkTime, closeWorkTime })
          },
        })
      },
    })
  })
}

export async function setPomodoroToWork(force: boolean = true): Promise<void> {
  const now = Date.now()

  await upsertData({
    db: myDb.db,
    tableName: tableName,
    data: { key: 'startWorkTime', value: JSON.stringify(now) },
    config: { primaryKey: 'key' },
    callback: () => {},
  })

  await upsertData({
    db: myDb.db,
    tableName: tableName,
    data: { key: 'closeWorkTime', value: JSON.stringify(now) },
    config: { primaryKey: 'key' },
    callback: () => {},
  })

  if (force) {
    await upsertData({
      db: myDb.db,
      tableName: tableName,
      data: {
        key: 'pomodoroForce',
        value: JSON.stringify({
          force: true,
          time: now,
          from: 'rest',
          to: 'work',
        }),
      },
      config: { primaryKey: 'key' },
      callback: () => {},
    })
  }
}

export function initStore() {
  ipcMain.on("get-stort-all", (e) => {
    // const storeData = getAllStore();
    // e.returnValue = storeData;

    // 查询插入成功的数据
    queryByConditions({
      db: myDb.db,
      tableName: tableName,
      conditions: {},
      callback: (err, data) => {
        if (err) {
          console.log(err, "err");
          e.returnValue = "error";
        } else {
          e.returnValue = data;
        }
      },
    });
  });

  ipcMain.on("get-store", (e, key: any) => {
    // e.returnValue = store.get(key);

    // 查询插入成功的数据
    queryByConditions({
      db: myDb.db,
      tableName: tableName,
      conditions: {
        key: key,
      },
      callback: (err, data) => {
        if (err) {
          console.log(err, "err");
          e.returnValue = null;
        } else {
          // console.log(colors.bgGreen(data), "data");
          e.returnValue = data.length > 0 ? JSON.parse(data[0].value) : null;
        }
      },
    });
  });

  ipcMain.on("set-store", async (e, key: any, value: any) => {
    // if (key === "multi-field") {
    //   // e.returnValue = store.set(value);
    // } else {
    //   e.returnValue = store.set(key, value);
    // }
    // 插入数据
    // console.log(colors.bgYellow(key), colors.red(value))
    await upsertData({
      db: myDb.db,
      tableName: tableName,
      data: key === "multi-field" ? value : { key, value: JSON.stringify(value) },
      config: {
        primaryKey: "key",
      },
      callback: async (err, result) => {
        if (err) {
          console.log(err, "err");
          e.returnValue = "error";
        } else {
          if (key === "multi-field") {
            e.returnValue = "ok";
            return;
          }
          // 查询插入成功的数据
          await queryByConditions({
            db: myDb.db,
            tableName: tableName,
            conditions: {
              key: key,
            },
            callback: (err, data) => {
              // console.log(colors.bgGreen(data), "data");

              if (err) {
                console.log(err, "err");
                e.returnValue = "error";
              } else {
                e.returnValue = data.length > 0 ? JSON.parse(data[0].value) : null;
              }
            },
          });
        }
      },
    });
  });

  // store替换
  ipcMain.on("replace-store", (e, value: any) => {
    // 禁止替换 disabledShowKeys中的key
    const isObject =
      Object.prototype.toString.call(value) === "[object Object]";
    if (!isObject) {
      e.returnValue = "error";
      return;
    }
    // 禁止替换 disabledShowKeys中的key
    const disabledShowKeysData = getDisabledShowKeysData();
    // store.store = {
    //   ...value,
    //   ...disabledShowKeysData,
    // };
    const newStoreData = {
      ...value,
      ...disabledShowKeysData,
    };
    // 将newStoreData转成[{key, value}]形式的数组
    const newStoreDataArray = Object.keys(newStoreData).map((key) => ({
      key,
      value: newStoreData[key],
    }));
    // 插入数据
    upsertData({
      db: myDb.db,
      tableName: tableName,
      data: newStoreDataArray,
      config: {
        primaryKey: "key",
      },
      callback: async (err, result) => {
        if (err) {
          console.log(err, "err");
          e.returnValue = "error";
        } else {
          e.returnValue = "ok";
          return;
        }
      },
    });
  });

  ipcMain.on("clear-store", (e) => {
    // 禁止替换 disabledShowKeys中的key
    const disabledShowKeysData = getDisabledShowKeysData();
    store.store = {
      ...disabledShowKeysData,
    };

    e.returnValue = "清空成功";
  });
}
