import Image from "next/image";

export function StudentBrand({ compact = false }: { compact?: boolean }) {
  return (
    <Image
      alt="TPS · TOEFL Practice System"
      className={compact ? "h-auto w-[132px] object-contain" : "h-auto w-[184px] object-contain"}
      height={724}
      priority
      src="/brand/tps-logo.png"
      width={2172}
    />
  );
}
