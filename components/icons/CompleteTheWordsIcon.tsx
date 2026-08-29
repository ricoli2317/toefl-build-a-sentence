import { forwardRef, type SVGProps } from "react";

export type CompleteTheWordsIconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
};

/** Shared four-way word-piece symbol for Complete the Words surfaces. */
export const CompleteTheWordsIcon = forwardRef<SVGSVGElement, CompleteTheWordsIconProps>(
  function CompleteTheWordsIcon(
    { size = 24, strokeWidth = 1.9, ...props },
    ref
  ) {
    return (
      <svg
        fill="none"
        height={size}
        ref={ref}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
        viewBox="0 0 24 24"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
        {...props}
      >
        <rect height="6.5" rx="2.4" width="5.5" x="9.25" y="3.25" />
        <rect height="5.5" rx="2.4" width="6.5" x="14.25" y="9.25" />
        <rect height="6.5" rx="2.4" width="5.5" x="9.25" y="14.25" />
        <rect height="5.5" rx="2.4" width="6.5" x="3.25" y="9.25" />
      </svg>
    );
  }
);
