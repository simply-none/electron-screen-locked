<template>
  <app-dialog
    :model-value="visible"
    title="导出主题"
    width="440px"
    append-to-body
    @update:model-value="$emit('update:visible', $event)"
  >
    <div class="export-themes">
      <p class="hint">勾选要导出的主题，将合并导出为单个 Markdown 文件。</p>

      <!-- 全选 / 反选 -->
      <div class="toolbar">
        <button class="link-btn" @click="toggleAll">{{ allChecked ? '取消全选' : '全选' }}</button>
        <span class="sel-count">已选 {{ checked.length }} / {{ rows.length }}</span>
      </div>

      <!-- 主题勾选列表（树状缩进） -->
      <div class="list">
        <label
          v-for="row in rows"
          :key="row.theme.id"
          class="row"
          :style="row.depth > 0 ? { paddingLeft: 12 + row.depth * 16 + 'px' } : null"
        >
          <input type="checkbox" :value="row.theme.id" v-model="checked" />
          <LucideIcon
            :name="row.depth > 0 ? 'CornerDownRight' : 'Hash'"
            :size="13"
            class="row-ico"
          />
          <span class="name">{{ row.theme.title || '未命名主题' }}</span>
          <span class="count">{{ counts[row.theme.id] || 0 }}</span>
        </label>
      </div>
    </div>

    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :disabled="!checked.length" @click="confirm">
        导出选中（{{ checked.length }}）
      </el-button>
    </template>
  </app-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import LucideIcon from '@/components/LucideIcon.vue';
import { useThemeConversation } from '../composables/useThemeConversation';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{
  (e: 'update:visible', v: boolean): void;
  (e: 'confirm', ids: number[]): void;
}>();

// 复用全局状态：平铺主题树（含缩进深度）与各主题对话数
const { flatThemeTree, themeCounts } = useThemeConversation();
const rows = computed(() => flatThemeTree.value);
const counts = computed(() => themeCounts.value);

const checked = ref<number[]>([]);

const allChecked = computed(
  () => rows.value.length > 0 && checked.value.length === rows.value.length,
);

// 每次打开重置勾选
watch(
  () => props.visible,
  (v) => {
    if (v) checked.value = [];
  },
);

function toggleAll() {
  checked.value = allChecked.value ? [] : rows.value.map((r) => r.theme.id);
}

function close() {
  emit('update:visible', false);
}

function confirm() {
  emit('confirm', [...checked.value]);
  close();
}
</script>

<style scoped lang="scss">
.export-themes {
  display: flex;
  flex-direction: column;
  gap: 10px;

  .hint {
    margin: 0;
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;

    .link-btn {
      border: none;
      background: transparent;
      color: var(--color-primary);
      cursor: pointer;
      font-size: 13px;
      padding: 2px 0;
    }
    .sel-count {
      font-size: 12px;
      color: var(--text-muted);
    }
  }

  .list {
    max-height: 320px;
    overflow-y: auto;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-btn);
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;

    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 8px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s;

      &:hover {
        background: var(--bg-hover);
      }

      input {
        accent-color: var(--color-primary);
        cursor: pointer;
      }

      .row-ico {
        color: var(--text-muted);
        flex-shrink: 0;
      }
      .name {
        flex: 1;
        font-size: 13px;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .count {
        font-size: 11px;
        color: var(--text-muted);
        background: var(--bg-active-btn);
        border-radius: 10px;
        padding: 0 7px;
        flex-shrink: 0;
      }
    }
  }
}
</style>
