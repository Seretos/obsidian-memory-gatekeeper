import { App } from "obsidian";
import type { StatusStore } from "./status-store";

const CLASSES = ["gatekeeper-new", "gatekeeper-modified"];

/**
 * Marks divergent files in the file explorer by toggling CSS classes on the
 * `.nav-file-title[data-path]` elements. There is no official API for this, so
 * we re-apply whenever the status changes and on layout changes (Obsidian
 * rebuilds explorer DOM on certain interactions).
 */
export class ExplorerDecorator {
  constructor(
    private app: App,
    private store: StatusStore,
  ) {}

  refresh(): void {
    const titles = document.querySelectorAll<HTMLElement>(".nav-file-title");
    titles.forEach((el) => {
      el.classList.remove(...CLASSES);
      const relPath = el.getAttribute("data-path");
      if (!relPath) return;
      const status = this.store.statusOf(relPath);
      if (status === "new") el.classList.add("gatekeeper-new");
      else if (status === "modified") el.classList.add("gatekeeper-modified");
    });
  }

  clear(): void {
    document
      .querySelectorAll<HTMLElement>(".nav-file-title")
      .forEach((el) => el.classList.remove(...CLASSES));
  }
}
