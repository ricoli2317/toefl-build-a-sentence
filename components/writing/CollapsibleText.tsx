"use client";

import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

type CollapsibleTextProps = {
  value: string;
  className?: string;
  buttonClassName?: string;
  lines?: number;
};

export function CollapsibleText({
  value,
  className = "text-[10px] leading-4",
  buttonClassName = "text-[9px]",
  lines = 3
}: CollapsibleTextProps) {
  const paragraphRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [collapsible, setCollapsible] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [value]);

  useEffect(() => {
    if (expanded) return;

    const measure = () => {
      const paragraph = paragraphRef.current;
      if (!paragraph) return;
      setCollapsible(paragraph.scrollHeight > paragraph.clientHeight + 1);
    };

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [expanded, lines, value]);

  return (
    <div className="min-w-0 text-student-muted">
      <p
        className={clsx("mt-0.5", className)}
        ref={paragraphRef}
        style={
          expanded
            ? undefined
            : {
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: lines,
                overflow: "hidden"
              }
        }
      >
        {value}
      </p>
      {collapsible || expanded ? (
        <button
          className={clsx(
            "mt-0.5 font-semibold text-student-primary hover:underline",
            buttonClassName
          )}
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded ? "收起" : "展开"}
        </button>
      ) : null}
    </div>
  );
}
