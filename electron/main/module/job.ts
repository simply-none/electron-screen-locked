import { ipcMain } from "electron";
import { CronJob } from "cron";
import moment from "moment";
import { win, hideApp, focusAppToTop } from "./mainWindow.ts";
import { createOtherWindow } from "./newWindow.ts";
import { upsertData } from "../utils/sql.ts";
import { myDb } from "./newSql.ts";
import { tableName } from "./store.ts";

let job = {
  // 工作/休息定时器
  workOrRest: null,
};
// 停止job
let sJob = {

}

export function createJob({
  win,
  time = 5 * 60 * 1000,
  onTick = () => {},
  isTick = true,
  msgName = "tip-job",
  type = 'workOrRest',
}) {
  if (job[type]) {
    stopJob(type);
  }
  let jobTime = time;
  if (jobTime < 5 * 1000) jobTime = 5 * 1000;

  const currentSecondTime = new Date().getSeconds();
  const currentMinuteTime = new Date().getMinutes();
  console.log(currentSecondTime, jobTime);
  const nextRunTime = moment().add(jobTime, "milliseconds").toDate();

  try {
    job[type] = new CronJob(
      nextRunTime, // cronTime
      function () {
        onTick();
        if (!isTick) return;
        win?.webContents.send(msgName, Date.now() + 1000);
      }, // onTick
      null, // onComplete
      true, // start
      'Asia/Shanghai' // timeZone
    );
  } catch (error) {
    let truthMsg = error.message || error.toString();
    if (truthMsg.includes("Date in past")) {
      // 如果是过去的时间，则直接执行
      onTick();
      if (!isTick) return;
      win?.webContents.send(msgName, Date.now() + 1000);
    } else {
      throw error;
    }
  }
}

export function stopJob(type?: string) {
  if (!type) {
    // 清除所有的job
    for (const key in job) {
      if (Object.prototype.hasOwnProperty.call(job, key)) {
        stopJob(key);
      }
    }
  } else {
    job[type]?.stop();
    job[type] = null;
    delete job[type];
  }
}

export function initJob() {
  // 提醒（含番茄钟、待办截止提醒）引擎已整体迁移至 newReminder.ts（initNewReminder）：
  // 待办截止提醒现由引擎的 syncTodoReminders 统一调度（recurrence.ts 生成重复实例后调用）。
  // 此处仅保留工作/休息定时器（createJob / startJobFn）。

  // 开启job
  ipcMain.on("start-job", (e, { type, gap, auto }: { type: 'string', gap: number | string, auto: boolean }) => {
    startJobFn({ type, gap, auto });
  });

  // 停止job
  ipcMain.on("stop-job", (e, {type}: { type?: string }) => {
    console.log(type, 'stop-job');
    sJob[type] = Date.now()
    stopJob(type);
  });
}

export async function startJobFn({ type, gap, auto }: { type: 'string', gap: number | string, auto: boolean }) {
  if (!auto) {
    sJob[type] = Date.now()
    let isNaN = Number.isNaN(Number(gap));
    // 插入数据
    await upsertData({
      db: myDb.db,
      tableName: tableName,
      data: {
        key: 'job-tip:' + type,
        value: JSON.stringify({
          type,
          time: Date.now(),
          gap: isNaN ? 1000 * 60 * 60 : Number(gap),
          endTipTime: Date.now() + (isNaN ? 1000 * 60 * 60 : Number(gap)),
        })
      },
      config: {
        primaryKey: "key",
      },
      callback: async (err, result) => {
        if (err) {
          console.log(err, "err");
        } else {
          win?.webContents.send("job-start-tip", {
            type,
            time: Date.now(),
            gap: isNaN ? 1000 * 60 * 60 : Number(gap),
          });
        }
      },
    });
  }
  let sJobType = sJob[type]
  let isNaN = Number.isNaN(Number(gap));
    createJob({
      win,
      type,
      msgName: "start-" + type,
      time: isNaN ? 1000 * 60 * 60 : Number(gap),
      isTick: false,
      onTick: async () => {
        if (sJobType != sJob[type]) {
          return;
        }

        // 插入数据
        await upsertData({
          db: myDb.db,
          tableName: tableName,
          data: {
            key: 'job-tip:' + type,
            value: JSON.stringify({
              type,
              time: Date.now(),
              gap: isNaN ? 1000 * 60 * 60 : Number(gap),
              endTipTime: Date.now() + (isNaN ? 1000 * 60 * 60 : Number(gap)),
            })
          },
          config: {
            primaryKey: "key",
          },
          callback: async (err, result) => {
            if (err) {
              console.log(err, "err");
            } else {
              // 发送提醒
              createOtherWindow("jobTipWindow", {
                resizable: true,
                frame: false,
                width: 200,
                height: 100,
                // center: true,
                transparent: true,
                mouseEvents: true,
                fullscreenable: false,
                x: 100,
                y: 100,
              })
              win?.webContents.send("job-end-tip", {
                type,
                time: Date.now(),
                gap: isNaN ? 1000 * 60 * 60 : Number(gap),
              });
            }
          },
        });
        // 新一轮计时
        startJobFn({ type, gap, auto: true });
      },
    });
}

export default {
  createJob,
  stopJob,
};
