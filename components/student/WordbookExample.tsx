"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { twoLinePrefix, wordbookExampleTail } from "@/lib/lexical/wordbookPresentation";
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
      // clientWidth rounds fractional table widths; measure the actual CSS box.
      const width = container.getBoundingClientRect().width;
      if (!width) return;
      const computed = getComputedStyle(container.firstElementChild ?? container);
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
        // A span is NOT layout-equivalent to a native button (atomic inline box).
        const suffix = document.createElement("button");
        suffix.type = "button";
        suffix.tabIndex = -1;
        suffix.className = styles.exampleToggle;
        suffix.textContent = "...";
        const tail = document.createElement("span");
        tail.className = styles.exampleTail;
        const lineHeight = parseFloat(getComputedStyle(probe).lineHeight);
        const result = twoLinePrefix(text, (value, toggle) => {
          const [body, last] = wordbookExampleTail(value);
          tail.replaceChildren(document.createTextNode(last), suffix);
          probe.replaceChildren(document.createTextNode(toggle ? body : value), ...(toggle ? [tail] : []));
          const box = probe.getBoundingClientRect();
          return box.height <= lineHeight * 2 && (!toggle || suffix.getBoundingClientRect().bottom <= box.top + lineHeight * 2);
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
  const [body, last] = wordbookExampleTail(prefix ?? "");
  const toggle = prefix !== null ? <button type="button"
      className={styles.exampleToggle} aria-expanded={expanded} aria-label={expanded ? "收起例句" : "展开完整例句"}
      onClick={() => setExpanded(value => !value)}>{expanded ? " 收起" : "..."}</button> : null;
  return <div ref={root} className={styles.exampleContainer}>
    <p className={styles.exampleText}>{expanded || prefix === null ? <>{text}{toggle}</> : <>{body}<span className={styles.exampleTail}>{last}{toggle}</span></>}</p>
  </div>;
}
