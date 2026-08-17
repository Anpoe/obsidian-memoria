// ================= 标签联想下拉框 =================
// 监听 textarea 输入，当光标处于 #xxx 这种"未闭合标签"时弹出建议
// 数据来源：当前 Memoria 数据集中的标签。
// 不读取 metadataCache，避免把 Vault 里其他文件的全局标签带进来。

import { Platform, setIcon } from "obsidian";
import { replaceTextareaRange } from "./textarea-utils";

export interface TagSuggestion {
  name: string;
  count: number;
}

export class TagSuggest {
  private dropdown: HTMLElement | null = null;
  private items: string[] = [];
  private active = 0;
  private rangeStart = 0; // 触发位置（# 字符所在的索引）

  private blurTimer: number | null = null;
  private viewport: VisualViewport | null = null;
  private repositionTimers: number[] = [];
  private windowListenersAttached = false;
  private documentListenerAttached = false;

  constructor(
    private textarea: HTMLTextAreaElement,
    private getTagSuggestions: () => TagSuggestion[]
  ) {
    this.textarea.addEventListener("input", this.handleInput);
    this.textarea.addEventListener("keydown", this.handleKeydown, true);
    this.textarea.addEventListener("blur", this.handleBlur);
    this.textarea.addEventListener("focus", this.handleFocus);
    this.textarea.addEventListener("scroll", this.handleScroll);
  }

  destroy(): void {
    this.textarea.removeEventListener("input", this.handleInput);
    this.textarea.removeEventListener("keydown", this.handleKeydown, true);
    this.textarea.removeEventListener("blur", this.handleBlur);
    this.textarea.removeEventListener("focus", this.handleFocus);
    this.textarea.removeEventListener("scroll", this.handleScroll);
    this.clearBlurTimer();
    this.close();
  }

  // -------- 事件 --------

  private handleInput = (): void => {
    // 工具栏按钮可能先让 textarea blur，再由 insertAtCursor() 重新 focus。
    // 输入事件已经证明编辑器重新活跃，取消旧的延迟关闭，避免建议框闪退。
    this.clearBlurTimer();
    const trigger = this.detectTrigger();
    if (!trigger) {
      this.close();
      return;
    }
    this.rangeStart = trigger.start;
    const all = this.collectAllTags();
    this.items = this.match(all, trigger.query);
    if (this.items.length === 0) {
      this.close();
      return;
    }
    this.active = 0;
    this.render();
  };

  private handleBlur = (): void => {
    this.clearBlurTimer();
    // Android WebView 在输入法候选、键盘尺寸变化和工具栏点击过程中会把
    // activeElement 短暂切到 body。这里若按 blur 关闭，建议框就会“闪一下”后
    // 消失。移动端改由 document pointerdown 判断真正的外部点击来关闭。
    if (this.isMobileLayout()) {
      this.schedulePosition();
      return;
    }
    // Android 输入法弹出、工具栏按钮回焦时都可能产生短暂 blur。
    // 延迟后再确认焦点确实离开输入区，避免建议框“闪一下就消失”。
    this.blurTimer = window.setTimeout(() => {
      this.blurTimer = null;
      if (activeDocument.activeElement === this.textarea) return;
      this.close();
    }, 360);
  };

  private handleFocus = (): void => {
    this.clearBlurTimer();
    if (this.dropdown) this.schedulePosition();
  };

  private handleScroll = (): void => {
    // 键盘弹起和 textarea 自动滚动都会触发 scroll；这里只重定位，不能关闭。
    this.schedulePosition();
  };

  private clearBlurTimer(): void {
    if (this.blurTimer !== null) {
      window.clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }
  }

  private clearRepositionTimers(): void {
    for (const timer of this.repositionTimers) window.clearTimeout(timer);
    this.repositionTimers = [];
  }

  private handleKeydown = (e: KeyboardEvent): void => {
    if (!this.dropdown) return;
    // v2.0.7: IME 组合态下的 Enter/Tab 是"确认候选词"，不是选择下拉项
    //   否则中文输入法打 #xxx 时按 Enter 上屏拼音会被联想面板吞掉。
    //   和 view.ts 主 keydown 的修复思路完全一致。
    if (e.isComposing || (e as KeyboardEvent & { keyCode?: number }).keyCode === 229) {
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.active = (this.active + 1) % this.items.length;
      this.refreshActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.active = (this.active - 1 + this.items.length) % this.items.length;
      this.refreshActive();
    } else if (e.key === "Enter" || e.key === "Tab") {
      // Ctrl+Enter 是发送，让它通过；其他 Enter/Tab 拦截做选择
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      this.applySelected();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  };

  // -------- 触发检测 --------

  /**
   * 检测光标位置是否处于 "#xxx" 这种待补全状态
   * 返回 { start: # 字符位置, query: # 后到光标的字符 }
   */
  private detectTrigger(): { start: number; query: string } | null {
    const pos = this.textarea.selectionStart ?? 0;
    const text = this.textarea.value;
    // 向前找最近的 # 字符
    let i = pos - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === "#") {
        // # 前面必须是行首/空格/换行/中文标点之类的边界
        const prev = i === 0 ? " " : text[i - 1];
        if (/[\s\n\r,，。.!?！？（(]/.test(prev) || i === 0) {
          const query = text.slice(i + 1, pos);
          // query 必须是合法标签字符
          if (/^[A-Za-z0-9_\u4e00-\u9fff/]*$/.test(query)) {
            return { start: i, query };
          }
        }
        return null;
      }
      // 遇到空白/换行就停
      if (/[\s\n\r]/.test(ch)) return null;
      // 遇到非标签字符也停
      if (!/[A-Za-z0-9_\u4e00-\u9fff/]/.test(ch)) return null;
      i--;
    }
    return null;
  }

  // -------- 数据 --------

  /** 收集当前 Memoria 数据集里的标签，按使用频率排序。 */
  private collectAllTags(): TagSuggestion[] {
    // 每次输入都从 store 的快照重新读取，保证刚保存/刚编辑的标签立即可见，
    // 同时从根上避免引入 Vault 其他文件里的全局标签。
    return this.getTagSuggestions()
      .slice()
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  /** 模糊匹配：优先前缀，其次包含 */
  private match(
    all: { name: string; count: number }[],
    query: string
  ): string[] {
    if (!query) {
      // 空查询：显示前 8 个最常用
      return all.slice(0, 8).map((x) => x.name);
    }
    const q = query.toLowerCase();
    const prefix: { name: string; count: number }[] = [];
    const contain: { name: string; count: number }[] = [];
    for (const t of all) {
      const lower = t.name.toLowerCase();
      if (lower === q) continue; // 完全相同就不必建议
      if (lower.startsWith(q)) prefix.push(t);
      else if (lower.includes(q)) contain.push(t);
      // 也支持子段匹配（# 行 -> #知识/十万个为什么）
      else {
        const segs = lower.split("/");
        if (segs.some((s) => s.startsWith(q))) contain.push(t);
      }
    }
    return [...prefix, ...contain].slice(0, 8).map((x) => x.name);
  }

  // -------- UI --------

  private render(): void {
    if (!this.dropdown) {
      this.dropdown = activeDocument.body.createDiv({ cls: "memoria-tag-suggest" });
      // 阻止点击下拉框时 textarea 的 blur 抢先关闭
      this.dropdown.addEventListener("mousedown", (e) => e.preventDefault());
      this.attachViewportListeners();
    }
    this.dropdown.empty();
    this.items.forEach((name, i) => {
      const item = this.dropdown!.createDiv({
        cls:
          "memoria-tag-suggest-item" + (i === this.active ? " active" : ""),
      });
      const icon = item.createSpan({ cls: "memoria-tag-suggest-icon" });
      setIcon(icon, "hash");
      item.createSpan({ cls: "memoria-tag-suggest-name", text: name });
      // 移动端有时不会先派发可阻止 blur 的 mousedown；触摸按下时直接应用，
      // 避免输入法弹起后下拉框被系统键盘抢走，随后 click 才到达的竞态。
      item.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "touch") return;
        event.preventDefault();
        event.stopPropagation();
        this.active = i;
        this.applySelected();
      });
      item.addEventListener("click", () => {
        this.active = i;
        this.applySelected();
      });
    });
    this.schedulePosition();
  }

  private refreshActive(): void {
    if (!this.dropdown) return;
    const items = this.dropdown.querySelectorAll(".memoria-tag-suggest-item");
    items.forEach((el, i) => {
      el.toggleClass("active", i === this.active);
    });
    // 滚动到可见
    const activeEl = items[this.active] as HTMLElement | undefined;
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }

  private attachViewportListeners(): void {
    const viewport = window.visualViewport;
    if (viewport && this.viewport !== viewport) {
      this.viewport = viewport;
      viewport.addEventListener("resize", this.handleViewportChange);
      viewport.addEventListener("scroll", this.handleViewportChange);
    }
    if (!this.windowListenersAttached) {
      this.windowListenersAttached = true;
      window.addEventListener("resize", this.handleViewportChange);
      window.addEventListener("orientationchange", this.handleViewportChange);
    }
    if (!this.documentListenerAttached) {
      this.documentListenerAttached = true;
      activeDocument.addEventListener(
        "pointerdown",
        this.handleDocumentPointerDown,
        true
      );
    }
  }

  private detachViewportListeners(): void {
    if (this.viewport) {
      this.viewport.removeEventListener("resize", this.handleViewportChange);
      this.viewport.removeEventListener("scroll", this.handleViewportChange);
      this.viewport = null;
    }
    if (this.windowListenersAttached) {
      window.removeEventListener("resize", this.handleViewportChange);
      window.removeEventListener("orientationchange", this.handleViewportChange);
      this.windowListenersAttached = false;
    }
    if (this.documentListenerAttached) {
      activeDocument.removeEventListener(
        "pointerdown",
        this.handleDocumentPointerDown,
        true
      );
      this.documentListenerAttached = false;
    }
  }

  private handleViewportChange = (): void => {
    this.schedulePosition();
  };

  private handleDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (this.dropdown?.contains(target)) return;
    const inputCard = this.textarea.closest<HTMLElement>(".memoria-input-card");
    if (inputCard?.contains(target)) return;
    this.close();
  };

  private isMobileLayout(): boolean {
    return (
      Platform.isMobile ||
      activeDocument.body.hasClass("is-mobile") ||
      window.matchMedia(
        "(hover: none), (pointer: coarse), (max-width: 680px)"
      ).matches
    );
  }

  /** 键盘有展开动画，连续在当前帧、80ms、240ms 三个时点重新定位。 */
  private schedulePosition(): void {
    if (!this.dropdown) return;
    this.clearRepositionTimers();
    this.position();
    window.requestAnimationFrame(() => this.position());
    this.repositionTimers = [80, 240].map((delay) =>
      window.setTimeout(() => this.position(), delay)
    );
  }

  /** 把下拉定位到 textarea 附近，并避开移动端输入法占用的可视区域 */
  private position(): void {
    if (!this.dropdown) return;
    const textareaRect = this.textarea.getBoundingClientRect();
    const inputCard = this.textarea.closest<HTMLElement>(".memoria-input-card");
    const mobileLayout = this.isMobileLayout();
    // 手机上输入卡片本身已经被 Obsidian 放到键盘上方，因此建议框直接锚定
    // 在整张输入卡上方，比猜测不同 Android WebView 的键盘高度稳定得多。
    const anchorRect =
      mobileLayout && inputCard
        ? inputCard.getBoundingClientRect()
        : textareaRect;
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const root = activeDocument.documentElement;
    const layoutHeight = root.clientHeight || window.innerHeight;
    const layoutWidth = root.clientWidth || window.innerWidth;
    const viewportWidth = Math.min(
      viewport?.width ?? layoutWidth,
      window.innerWidth,
      layoutWidth
    );
    const viewportHeight = Math.min(
      viewport?.height ?? layoutHeight,
      window.innerHeight,
      layoutHeight
    );
    const viewportBottom = viewportTop + viewportHeight;
    const viewportRight = viewportLeft + viewportWidth;
    const margin = 8;
    const estimatedHeight = Math.min(280, Math.max(48, this.items.length * 34 + 8));
    const spaceBelow = Math.max(0, viewportBottom - textareaRect.bottom - margin);
    const spaceAbove = Math.max(0, anchorRect.top - viewportTop - margin);
    const showAbove =
      mobileLayout ||
      (spaceBelow < estimatedHeight && spaceAbove > spaceBelow);
    const maxHeight = Math.max(
      48,
      Math.min(280, showAbove ? spaceAbove : Math.max(spaceBelow, 48))
    );
    this.dropdown.style.maxHeight = `${maxHeight}px`;

    const actualHeight = Math.min(
      this.dropdown.scrollHeight || estimatedHeight,
      maxHeight
    );
    const preferredTop = showAbove
      ? anchorRect.top - actualHeight - 4
      : textareaRect.bottom + 4;
    const minTop = viewportTop + margin;
    const maxTop = Math.max(minTop, viewportBottom - actualHeight - margin);
    const top = Math.max(minTop, Math.min(preferredTop, maxTop));
    const availableWidth = Math.max(120, viewportWidth - margin * 2);
    const width = Math.min(anchorRect.width, 280, availableWidth);
    const preferredLeft = anchorRect.left + 4;
    const minLeft = viewportLeft + margin;
    const maxLeft = Math.max(minLeft, viewportRight - width - margin);
    const left = Math.max(minLeft, Math.min(preferredLeft, maxLeft));
    this.dropdown.style.top = `${top}px`;
    this.dropdown.style.left = `${left}px`;
    this.dropdown.style.minWidth = `${width}px`;
    this.dropdown.style.maxWidth = `${availableWidth}px`;
  }

  private applySelected(): void {
    if (!this.dropdown || !this.items.length) return;
    const chosen = this.items[this.active];
    const pos = this.textarea.selectionStart ?? 0;
    // 替换 [rangeStart, pos) 为 #chosen + 空格
    // v2.1.0-iter8: 用 replaceTextareaRange 保留 undo（之前 Ctrl+Z 不工作就是这里搞的）
    const insert = `#${chosen} `;
    replaceTextareaRange(this.textarea, this.rangeStart, pos, insert);
    this.textarea.focus();
    this.close();
  }

  private close(): void {
    this.clearBlurTimer();
    this.clearRepositionTimers();
    this.detachViewportListeners();
    if (this.dropdown) {
      this.dropdown.remove();
      this.dropdown = null;
    }
    this.items = [];
    this.active = 0;
  }
}
