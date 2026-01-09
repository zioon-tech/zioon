/**
 * 通知管理器
 * 提供统一的通知显示功能
 */
import type { PluginInfo } from '../plugin/types';

export interface NotificationOptions {
  type?: 'info' | 'success' | 'warning' | 'error';
  duration?: number;
  dismissible?: boolean;
  actions?: Array<{ label: string; handler: () => void }>;
}

/**
 * 通知管理器类
 */
export class NotificationManager {
  private container: HTMLElement | null = null;

  constructor() {
    this.ensureContainer();
    this.injectStyles();
  }

  /**
   * 确保通知容器存在
   */
  private ensureContainer() {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.id = 'zion-notification-container';
    this.container.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 100000;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 80vh;
      overflow-y: auto;
      pointer-events: none;
    `;
    document.body.appendChild(this.container);
  }

  /**
   * 注入通知样式
   */
  private injectStyles() {
    if (document.getElementById('zion-notification-styles')) return;

    const style = document.createElement('style');
    style.id = 'zion-notification-styles';
    style.textContent = `
      @keyframes zion-slide-in {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }

      @keyframes zion-fade-out {
        to { opacity: 0; transform: translateY(-10px); }
      }

      .zion-notification {
        pointer-events: auto;
        animation: zion-slide-in 0.3s ease-out;
        transition: all 0.2s ease;
      }

      .zion-notification.zion-fading-out {
        animation: zion-fade-out 0.2s ease-out forwards;
      }

      .zion-notification.zion-notification-info {
        border-left: 3px solid #58a6ff;
      }

      .zion-notification.zion-notification-success {
        border-left: 3px solid #2ea043;
      }

      .zion-notification.zion-notification-warning {
        border-left: 3px solid #d29922;
      }

      .zion-notification.zion-notification-error {
        border-left: 3px solid #f85149;
      }

      .zion-notification button {
        cursor: pointer;
        transition: background 0.15s ease;
      }

      .zion-notification button:hover {
        opacity: 0.8;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * 显示通知
   */
  show(message: string, options: NotificationOptions = {}): HTMLElement {
    const {
      type = 'info',
      duration = 5000,
      dismissible = true,
      actions = []
    } = options;

    const notification = document.createElement('div');
    notification.className = `zion-notification zion-notification-${type}`;

    const icons = {
      info: 'ℹ️',
      success: '✅',
      warning: '⚠️',
      error: '❌'
    };

    notification.style.cssText = `
      background: var(--panel, #1e1e1e);
      border: 1px solid var(--border, #30363d);
      border-radius: 6px;
      padding: 12px 16px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      max-width: 400px;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      color: var(--fg, #c9d1d9);
      font-size: 13px;
      line-height: 1.4;
    `;

    // 通知内容
    const contentDiv = document.createElement('div');
    contentDiv.style.cssText = 'flex: 1;';

    // 图标 + 消息行
    const messageRow = document.createElement('div');
    messageRow.style.cssText = 'display: flex; align-items: flex-start; gap: 8px;';

    const icon = document.createElement('span');
    icon.textContent = icons[type];
    icon.style.cssText = 'flex-shrink: 0;';

    const messageText = document.createElement('div');
    messageText.innerHTML = message;
    messageText.style.cssText = 'flex: 1;';

    messageRow.appendChild(icon);
    messageRow.appendChild(messageText);
    contentDiv.appendChild(messageRow);

    // 操作按钮
    if (actions.length > 0) {
      const actionsDiv = document.createElement('div');
      actionsDiv.style.cssText = 'margin-top: 8px; display: flex; gap: 6px;';

      actions.forEach((action, i) => {
        const btn = document.createElement('button');
        btn.textContent = action.label;
        btn.style.cssText = `
          background: ${i === 0 ? 'var(--accent, #58a6ff)' : 'var(--border, #30363d)'};
          border: none;
          color: ${i === 0 ? 'white' : 'var(--fg, #c9d1d9)'};
          border-radius: 3px;
          padding: 4px 10px;
          font-size: 11px;
        `;
        btn.onclick = () => {
          action.handler();
          this.dismiss(notification);
        };
        actionsDiv.appendChild(btn);
      });

      contentDiv.appendChild(actionsDiv);
    }

    notification.appendChild(contentDiv);

    // 关闭按钮
    if (dismissible) {
      const dismissBtn = document.createElement('button');
      dismissBtn.textContent = '✕';
      dismissBtn.style.cssText = `
        background: transparent;
        border: none;
        color: var(--fg, #c9d1d9);
        font-size: 14px;
        padding: 2px 6px;
        margin-left: 8px;
        opacity: 0.6;
      `;
      dismissBtn.onclick = () => this.dismiss(notification);
      notification.appendChild(dismissBtn);
    }

    // 添加到容器
    this.container!.appendChild(notification);

    // 自动消失
    if (duration > 0) {
      setTimeout(() => {
        this.dismiss(notification);
      }, duration);
    }

    return notification;
  }

  /**
   * 显示插件热重载通知
   */
  showPluginHotReload(pluginInfo: PluginInfo, devDir?: string): HTMLElement {
    const devDirText = devDir ? `<div style="opacity: 0.6; font-size: 11px; margin-top: 4px;">📁 ${devDir}</div>` : '';

    return this.show(
      `<strong>${pluginInfo.name}</strong> has been hot-reloaded<br><span style="opacity: 0.7;">v${pluginInfo.version}</span>${devDirText}`,
      {
        type: 'success',
        duration: 6000,
        actions: [
          {
            label: 'Reload Page',
            handler: () => window.location.reload()
          }
        ]
      }
    );
  }

  /**
   * 显示插件开发模式开始通知
   */
  showDevModeStarted(pluginName: string, devDir: string): HTMLElement {
    return this.show(
      `<strong>${pluginName}</strong> dev mode started<br><span style="opacity: 0.7; font-size: 11px;">📁 ${devDir}</span>`,
      {
        type: 'info',
        duration: 4000
      }
    );
  }

  /**
   * 显示插件开发模式停止通知
   */
  showDevModeStopped(pluginName: string): HTMLElement {
    return this.show(
      `<strong>${pluginName}</strong> dev mode stopped`,
      {
        type: 'info',
        duration: 3000
      }
    );
  }

  /**
   * 显示热重载错误通知
   */
  showHotReloadError(pluginName: string, error: string): HTMLElement {
    return this.show(
      `<strong>${pluginName}</strong> hot reload failed<br><span style="opacity: 0.7; font-size: 11px;">${error}</span>`,
      {
        type: 'error',
        duration: 8000
      }
    );
  }

  /**
   * 关闭通知
   */
  dismiss(notification: HTMLElement): void {
    if (!notification.parentElement) return;

    notification.classList.add('zion-fading-out');
    setTimeout(() => {
      if (notification.parentElement) {
        notification.remove();
      }
    }, 200);
  }

  /**
   * 清除所有通知
   */
  clear(): void {
    if (!this.container) return;
    const notifications = Array.from(this.container.children);
    notifications.forEach(notification => {
      this.dismiss(notification as HTMLElement);
    });
  }

  /**
   * 销毁通知管理器
   */
  dispose(): void {
    this.clear();
    this.container?.remove();
    this.container = null;

    // 移除样式
    const styles = document.getElementById('zion-notification-styles');
    styles?.remove();
  }
}

// 创建全局单例
export const notificationManager = new NotificationManager();
