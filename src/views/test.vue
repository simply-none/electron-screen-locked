<template>
  <div @click="send">
    测试
  </div>
  <div @click="quitApp">退出</div>
</template>

<script setup>
import moment from 'moment';
function send() {
  console.warn("测试", window.ipcRenderer);
  console.log(moment().isBetween(moment('11:50', 'HH:mm'), moment('15:30', 'HH:mm')), 't')
  console.log(moment().diff(moment('13:30', 'HH:mm'), 'seconds', true), '3')
  console.log(window.ipcRenderer.sendSync("test", "测试"), 't')
}

window.ipcRenderer.on("test", (event, arg) => {
  console.warn(arg);
});

function quitApp() {
    window.ipcRenderer.send('quit-app');
}

</script>

<style lang="scss" scoped>
div {
  padding: 20px;
  background-color: gray;
  color: white;
}
</style>