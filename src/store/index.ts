import { ref } from "vue";
import { defineStore } from "pinia";

interface Status {
  label?: string;
  value?: string;
}

export default defineStore("setting", () => {
  const curStatus = ref<Status>({})

  function updateCurStatus(status: any) {
    curStatus.value = status;
  }

  return {
    curStatus,
    updateCurStatus,
  };
});