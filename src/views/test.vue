<template>
  <div @click="send">
    测试
  </div>
</template>

<script setup>
function send() {
  console.warn("测试", window.ipcRenderer);
  console.log(window.ipcRenderer.sendSync("test", "测试"), 't')
}

window.ipcRenderer.on("test", (event, arg) => {
  console.warn(arg);
});

</script>

<style lang="scss" scoped>
div {
  padding: 20px;
  background-color: red;
  color: white;
}
</style>