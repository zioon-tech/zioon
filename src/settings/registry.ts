/**
 * SettingsRegistry — 设置项注册中心
 *
 * 核心层只做注册/注销，不关心具体配置内容。
 * 各模块/插件通过 registerItem() 注册自己的设置项。
 */

export interface SettingsItem {
  /** 唯一标识 */
  id: string;
  /** 分组（如 "Services", "Mail", "Skills"） */
  section: string;
  /** 显示标题 */
  title: string;
  /** 排序权重，默认 0（按注册顺序） */
  order?: number;
  /**
   * 插件自行渲染设置 UI
   * @param container 面板分配的容器节点
   * @returns 可选的 dispose 回调
   */
  render: (container: HTMLElement) => { dispose?: () => void } | void;
}

export interface Disposable {
  dispose(): void;
}

type ChangeHandler = () => void;

export class SettingsRegistry {
  private items = new Map<string, SettingsItem>();
  private renderers = new Map<string, { dispose?: () => void } | null>();
  private changeHandlers: ChangeHandler[] = [];

  /**
   * 注册一个设置项。如果 id 已存在，先注销旧的再注册新的。
   */
  registerItem(item: SettingsItem): Disposable {
    // 如果已存在，先清理
    if (this.items.has(item.id)) {
      this.disposeItem(item.id);
    }

    this.items.set(item.id, item);
    this.fireChange();

    return {
      dispose: () => {
        if (this.items.get(item.id) === item) {
          this.disposeItem(item.id);
          this.items.delete(item.id);
          this.fireChange();
        }
      }
    };
  }

  /**
   * 获取所有已注册的设置项，按 section 分组并排序
   */
  getItems(): SettingsItem[] {
    return Array.from(this.items.values()).sort((a, b) => {
      // 先按 section 字母排序，再按 order 排序
      const sectionCompare = a.section.localeCompare(b.section);
      if (sectionCompare !== 0) return sectionCompare;
      return (a.order ?? 0) - (b.order ?? 0);
    });
  }

  /**
   * 获取所有已注册的设置项，按 section 分组
   */
  getSections(): { section: string; items: SettingsItem[] }[] {
    const sectionMap = new Map<string, SettingsItem[]>();
    const sorted = this.getItems();
    for (const item of sorted) {
      const list = sectionMap.get(item.section) || [];
      list.push(item);
      sectionMap.set(item.section, list);
    }
    return Array.from(sectionMap.entries()).map(([section, items]) => ({
      section,
      items
    }));
  }

  /**
   * 监听设置项变更
   */
  onDidChange(handler: ChangeHandler): Disposable {
    this.changeHandlers.push(handler);
    return {
      dispose: () => {
        const idx = this.changeHandlers.indexOf(handler);
        if (idx >= 0) this.changeHandlers.splice(idx, 1);
      }
    };
  }

  private disposeItem(id: string) {
    const renderer = this.renderers.get(id);
    if (renderer) {
      try { renderer.dispose?.(); } catch {}
      this.renderers.delete(id);
    }
  }

  private fireChange() {
    for (const handler of this.changeHandlers) {
      try { handler(); } catch {}
    }
  }
}

/** 全局单例 */
export const settingsRegistry = new SettingsRegistry();
