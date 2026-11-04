import { calculateContainedScrollTop } from "./writingReviewWorkspaceUi.ts";

/** Shared ordinary/correction annotation navigation; scroll only the essay pane. */
export function scrollTargetWithinContainer(container: HTMLElement | null, target: HTMLElement | null, offset = 18) {
  if (!container || !target) return;
  container.scrollTo({ top: calculateContainedScrollTop({
    containerScrollTop: container.scrollTop, containerTop: container.getBoundingClientRect().top,
    targetTop: target.getBoundingClientRect().top, offset
  }), behavior: "smooth" });
}
