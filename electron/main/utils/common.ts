import fs from 'node:fs'
import path from 'node:path';

export function readFileList(dir, whiteExt = [], ignoreFolder = []) {
  let filesList = []
  let files = fs.readdirSync(dir);
  files.forEach(function (item, index) {
    if (ignoreFolder.includes(item)) return;
    let stat = fs.statSync(dir + item);
    if (stat.isDirectory()) {
      // console.log('检测到文件夹：' + dir + item);
      //递归读取文件
      readFileList(dir + item + "/", filesList)
    } else {
      if (whiteExt.includes(path.extname(dir + item))) {
        // console.log('检测到白名单文件，路径为：' + dir + item);
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

// 获取对象数组下的所有对象属性
export function getObjectKeys(objArr: ObjectType[] | ObjectType) {
  if (!Array.isArray(objArr)) objArr = [objArr]
  const keys = []
  objArr.forEach(obj => {
    keys.push(...Object.keys(obj))
  })
  // 去重不排序
  return [...new Set(keys)]
}

// 将一个对象数组[{ key, value }] 转换为 { key: value }
// 约定：value 为 JSON 序列化字符串时解析回对象；但部分偏好（如保险库“上次路径”）
// 直接以纯字符串（文件路径等）存储，这类非 JSON 字符串应原样保留，不应 JSON.parse 报错。
export function objectArrayToObject(objArr: ObjectType[]) {
  const obj = {}
  objArr.forEach(item => {
    if (typeof item.value === 'string') {
      const v = item.value.trim()
      // 仅对“看起来像 JSON”的字符串尝试解析（以 { [ " 数字 true/false/null 开头），
      // 纯字符串（如 C:\...\xxx.json 路径）直接保留原值，避免非法 JSON 抛错 / 刷屏。
      if (v && '{"[0123456789tfbn'.includes(v[0])) {
        try {
          obj[item.key] = JSON.parse(v)
          return
        } catch (e) {
          console.error('[objectArrayToObject] 值疑似 JSON 但解析失败，保留原值:', item.key, e)
        }
      }
      obj[item.key] = item.value
    } else {
      obj[item.key] = item.value
    }
  })
  return obj
}
