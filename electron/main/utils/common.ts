import fs from 'node:fs'
import path from 'node:path';

export function readFileList(dir, whiteExt = [], ignoreFolder = []) {
  let filesList = []
  let files = fs.readdirSync(dir);
  files.forEach(function (item, index) {
    if (ignoreFolder.includes(item)) return;
    let stat = fs.statSync(dir + item);
    if (stat.isDirectory()) {
      console.log('检测到文件夹：' + dir + item);
      //递归读取文件
      readFileList(dir + item + "/", filesList)
    } else {
      if (whiteExt.includes(path.extname(dir + item))) {
        console.log('检测到白名单文件，路径为：' + dir + item);
        filesList.push(dir + item);
      }
    }
  })
  return filesList
}

export function readJsonFileContent(url) {
  try {
    const data = fs.readFileSync(url, 'utf8');

    const content = JSON.parse(data);
    // 判断是否是数组
    if (Array.isArray(content)) {
      // 随机读取数组中的一项
      return content[Math.floor(Math.random() * content.length)]
    }
    return { error: true }
  } catch (err) {
    return { error: true }
  }
}