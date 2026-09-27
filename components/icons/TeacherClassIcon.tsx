import { forwardRef, type SVGProps } from "react";

export type TeacherClassIconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  strokeWidth?: number | string;
};

/**
 * Teacher "班级" symbol: a class roster card with two members. Drawn with the
 * same 24px grid, 1.9 stroke weight and round caps as the rest of the icon set.
 */
export const TeacherClassIcon = forwardRef<SVGSVGElement, TeacherClassIconProps>(
  function TeacherClassIcon({ size = 24, strokeWidth = 1.9, ...props }, ref) {
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
        <rect height="15.5" rx="2.6" width="17.5" x="3.25" y="4.25" />
        <path d="M3.25 9.25h17.5" />
        <circle cx="9.1" cy="13.1" r="1.55" />
        <path d="M6.3 17.6a2.8 2.8 0 0 1 5.6 0" />
        <circle cx="15" cy="13.1" r="1.55" />
        <path d="M12.2 17.6a2.8 2.8 0 0 1 5.6 0" />
      </svg>
    );
  }
);
