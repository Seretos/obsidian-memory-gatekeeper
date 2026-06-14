import { App } from "obsidian";
import type { StatusStore } from "./status-store";
import type { GatekeeperSettings } from "./types";
import { shouldOpenDiffByDefault, isPlainPrimaryClick } from "./core/open-diff-default";

const CLASSES = ["gatekeeper-new", "gatekeeper-modified"];

/**
 * Marks divergent files in the file explorer by toggling CSS classes on the
 * `.nav-file-title[data-path]` elements. There is no official API for this, so
 * we re-apply whenever the status changes and on layout changes (Obsidian
 * rebuilds explorer DOM on certain interactions).
 *
 * Additionally, captures click events on `.nav-file-title[data-path]` elements
 * (capture phase, so we run before Obsidian's own listener) and redirects to
 * CompareView when the file is divergent and the "open diff by default" setting
 * is enabled. Raw note access remains available via the right-click context menu.
 *
 * Fragile: the CSS selector `.nav-file-title[data-path]` is undocumented and
 * may change across Obsidian updates. The same fragility affects ExplorerDecorator's
 * existing class-toggling. The capture-phase listener is registered on `document`
 * and is removed in `clear()` via the same function reference.
 */
export class ExplorerDecorator {
  private clickHandler: (evt: MouseEvent) => void;

  constructor(
    private app: App,
    private store: StatusStore,
    private settings: GatekeeperSettings,
    private isConfigured: () => boolean,
    private openCompare: (relPath: string) => Promise<void>,
  ) {
    this.clickHandler = (evt: MouseEvent) => {
      try {
        // evt.target can be a Text node (not an Element) when clicking text
        // content directly — Text has no .closest(), so walk up to parentElement.
        const target = evt.target as Node | null;
        if (!target) return;
        const elementTarget = target instanceof Element ? target : target.parentElement;
        if (!elementTarget) return;
        const el = elementTarget.closest<HTMLElement>(".nav-file-title[data-path]");
        if (!el) return;
        const relPath = el.getAttribute("data-path");
        if (!relPath) return;
        // Let modifier-key clicks (Ctrl/Cmd/Alt/Shift) and non-primary buttons
        // pass through so Obsidian's default handling (e.g. open in new pane)
        // still works on divergent files.
        if (!isPlainPrimaryClick(evt)) return;
        const status = this.store.statusOf(relPath);
        if (
          shouldOpenDiffByDefault(
            status,
            this.settings.openDiffByDefault,
            this.isConfigured(),
          )
        ) {
          evt.preventDefault();
          evt.stopPropagation();
          void this.openCompare(relPath);
        }
      } catch {
        /* guard against any DOM or store access errors */
      }
    };
    document.addEventListener("click", this.clickHandler, { capture: true });
  }

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
    document.removeEventListener("click", this.clickHandler, { capture: true });
    document
      .querySelectorAll<HTMLElement>(".nav-file-title")
      .forEach((el) => el.classList.remove(...CLASSES));
  }
}
