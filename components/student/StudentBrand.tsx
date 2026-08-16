import Image from "next/image";

export function StudentBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <Image
        alt=""
        aria-hidden="true"
        className={compact ? "h-8 w-8 object-contain" : "h-11 w-11 object-contain"}
        height={compact ? 32 : 44}
        priority
        src="/brand/tps-mark.png"
        width={compact ? 32 : 44}
      />
      <div className={compact ? "leading-none" : "min-w-0"}>
        <span className={`${compact ? "text-xl" : "text-2xl"} font-black tracking-[-0.04em] text-student-primary`}>
          TPS
        </span>
        {compact ? null : (
          <p className="mt-0.5 whitespace-nowrap text-[11px] font-medium text-student-muted">
            TOEFL Practice System
          </p>
        )}
      </div>
    </div>
  );
}
