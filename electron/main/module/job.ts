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

// ============ 待办截止时间提醒调度 ============
let todoReminderJobs: Record<string, CronJob[]> = {};

// 从数据库读取全部待办
function getAllTodos(): Promise<any[]> {
  return new Promise((resolve) => {
    if (!myDb.db) {
      resolve([]);
      return;
    }
    myDb.db.all('SELECT * FROM todo_list', [], (err: any, rows: any[]) => {
      if (err) {
        console.error('读取待办失败:', err);
        resolve([]);
      } else {
        resolve(rows || []);
      }
    });
  });
}

// 触发待办提醒：通知渲染进程弹通知
function triggerTodoReminder(todo: any) {
  win?.webContents.send('todo-reminder-trigger', {
    ...todo,
    triggerTime: Date.now(),
  });
}

// 为单条待办排程：在截止时间前按「提醒次数 / 间隔」多次提醒
function scheduleTodoReminder(todo: any) {
  if (!todo || !todo.dueDate) return;
  // 提醒资格：已完成/已取消不排程；兼容旧数据（无 status 字段时按 completed 判断）
  const isDone = todo.status
    ? (todo.status === 'completed' || todo.status === 'cancelled')
    : Number(todo.completed) === 1;
  if (isDone) return;
  if (Number(todo.deadlineReminder) !== 1) return;

  const due = moment(todo.dueDate, 'YYYY-MM-DD HH:mm:ss').toDate().getTime();
  const now = Date.now();
  if (isNaN(due) || due <= now) return; // 已过期不排程

  const intervalMs =
    Number(todo.remindIntervalUnit === 'hour'
      ? Number(todo.remindInterval) * 3600000
      : Number(todo.remindInterval) * 60000) || 30 * 60000;
  const count = Math.min(50, Math.max(1, Number(todo.remindCount) || 1));

  const jobs: CronJob[] = [];
  for (let i = 0; i < count; i++) {
    const t = due - i * intervalMs;
    // 仅排程尚未到达（留出 1s 余量）的时间点，避免过去时间立即触发
    if (t > now + 1000) {
      const job = new CronJob(new Date(t), () => {
        triggerTodoReminder(todo);
      }, null, true, 'Asia/Shanghai');
      jobs.push(job);
    }
  }
  if (jobs.length > 0) {
    todoReminderJobs[todo.key] = jobs;
  }
}

// 清除所有待办提醒任务
function clearTodoReminderJobs() {
  for (const key in todoReminderJobs) {
    (todoReminderJobs[key] || []).forEach(j => j.stop());
    delete todoReminderJobs[key];
  }
}

// 全量应用待办截止提醒（先清空再按当前数据排程）
export async function applyTodoReminders() {
  clearTodoReminderJobs();
  const todos = await getAllTodos();
  (todos || []).forEach(todo => scheduleTodoReminder(todo));
}

// 应用启动时恢复待办截止提醒
async function restoreTodoReminders() {
  try {
    await applyTodoReminders();
  } catch (e) {
    console.error('恢复待办截止提醒失败:', e);
  }
}

export function initJob() {
  // 提醒（含番茄钟）引擎已整体迁移至 newReminder.ts（initNewReminder），此处只保留待办子系统。

  // 启动时恢复待办截止提醒
  restoreTodoReminders();

  // 待办新增/编辑/删除/完成切换后，重新排程截止提醒
  ipcMain.on("update-todo-reminders", () => {
    applyTodoReminders();
  });

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
