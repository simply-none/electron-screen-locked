<!--
  同步表选择器（原子组件）：白名单表的多选 chips。
  v-model:selectedTables 与 store 的勾选映射双向绑定。
-->
<template>
  <div class="table-selector">
    <el-checkbox
      v-for="table in tables"
      :key="table"
      :model-value="selectedTables[table]"
      size="small"
      @update:model-value="(v: any) => emit('update:selectedTables', { ...selectedTables, [table]: !!v })"
    >
      {{ table }}
    </el-checkbox>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  tables: readonly string[];
  selectedTables: Record<string, boolean>;
}>();

const emit = defineEmits<{
  (e: "update:selectedTables", v: Record<string, boolean>): void;
}>();
</script>

<style scoped lang="scss">
.table-selector {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
}
</style>
