import { ElMessage, ElMessageBox } from 'element-plus'

const open = (msg: string, confirmFn: () => void, cancelFn: () => void) => {
  ElMessageBox.confirm(
    msg,
    {
      confirmButtonText: '确认',
      cancelButtonText: '取消',
      type: 'warning',
    }
  )
    .then(() => {
      confirmFn()
    })
    .catch(() => {
      cancelFn()
    })
}

export default {
  open,
}