import { ElNotification } from 'element-plus'

export function sysNotify(title = '', bodyMsg = '', clickMsg = '') {
  const NOTIFICATION_TITLE = title
  const NOTIFICATION_BODY = bodyMsg
  const CLICK_MESSAGE = clickMsg

  new window.Notification(NOTIFICATION_TITLE, { body: NOTIFICATION_BODY })
    .onclick = () => { document.getElementById('output')!.innerText = CLICK_MESSAGE }
}

export function appNotify(title = '', bodyMsg = '', duration = 3000) {
  ElNotification({
    title: title,
    message: bodyMsg,
    position: 'bottom-right',
    duration: duration || 3000,
  })

}