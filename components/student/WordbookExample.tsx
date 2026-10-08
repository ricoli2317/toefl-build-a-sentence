"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { twoLinePrefix } from "@/lib/lexical/wordbookPresentation";
import styles from "./StudentWordbook.module.css";

export function WordbookExample({ text }: { text: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [prefix, setPrefix] = useState<string | null>(null);
  useLayoutEffect(() => {
    const container = root.current;
    if (!container) return;
    let disposed = false;
    let signature = "";
    const measure = () => {
      if (disposed) return;
      const width = container.clientWidth;
      if (!width) return;
      const computed = getComputedStyle(container);
      const next = `${width}:${computed.font}:${computed.lineHeight}:${computed.letterSpacing}`;
      if (next === signature) return;
      signature = next;
      // Temporary probe is out of flow and never observed; changing its text
      // cannot change table geometry or feed back into ResizeObserver.
      const probe = document.createElement("p");
      probe.className = styles.exampleText;
      probe.setAttribute("aria-hidden", "true");
      Object.assign(probe.style, { position: "absolute", visibility: "hidden", pointerEvents: "none", width: `${width}px`, top: "0", left: "0" });
      container.appendChild(probe);
      try {
        const suffix = document.createElement("span");
        suffix.className = styles.exampleToggle;
        suffix.textContent = "...";
        const lineHeight = parseFloat(getComputedStyle(probe).lineHeight);
        const result = twoLinePrefix(text, (value, toggle) => {
          probe.replaceChildren(document.createTextNode(value), ...(toggle ? [suffix] : []));
          return probe.getBoundingClientRect().height <= lineHeight * 2 + 0.5;
        });
        setPrefix(previous => previous === result ? previous : result);
      } finally { probe.remove(); }
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(container);
    const refresh = () => { signature = ""; measure(); };
    window.addEventListener("resize", refresh);
    document.fonts?.addEventListener("loadingdone", refresh);
    void document.fonts?.ready.then(refresh);
    return () => { disposed = true; observer?.disconnect(); window.removeEventListener("resize", refresh); document.fonts?.removeEventListener("loadingdone", refresh); };
  }, [text]);
  return <div ref={root} className={styles.exampleContainer}>
    <p className={styles.exampleText}>{expanded || prefix === null ? text : prefix}{prefix !== null ? <button type="button"
      className={styles.exampleToggle} aria-expanded={expanded} aria-label={expanded ? "收起例句" : "展开完整例句"}
      onClick={() => setExpanded(value => !value)}>{expanded ? " 收起" : "..."}</button> : null}</p>
  </div>;
}
