import { ipcMain } from "electron";
import path from "node:path";
import { createTable, queryByConditions, upsertData } from "../utils/sql.ts";
import { readFileList, readJsonFileContent } from "../utils/common.ts";
import { myDb } from "./newSql.ts";

export function initPoetData() {
  ipcMain.on("poet-data", (e, fullScreen: boolean) => {
    // 获取诗词数据，用于首页展示
    // let poetDataPathList = readFileList(
    //   path.join(process.env.VITE_PUBLIC, "/宋词/"),
    //   [".json"]
    // );
    // let randomFile =
    //   poetDataPathList[Math.floor(Math.random() * poetDataPathList.length)];
    // let randomPoetData = readJsonFileContent(randomFile);
    
    // e.returnValue = randomPoetData;

    let tableName = Math.random() > 0.5 ? "ci" : "ciauthor"
    queryByConditions({
      db: myDb.shiciDb,
      tableName,
      conditions: {
        SqlStr: `SELECT * FROM ${tableName} ORDER BY RANDOM() LIMIT 1`,
      },
      callback: (err, res) => {
        console.log('测试诗词数据：', res)
        if (err) {
          console.error(err);
          return e.returnValue = {};
        }
        let value = res && res.length > 0 ? res[0] : {};
        let paragraphs = (value.content || '').split('\n')
        value.paragraphs = paragraphs.map(p => p.trim())
        return e.returnValue = value
      },
    });
  });
}
