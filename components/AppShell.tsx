import Link from "next/link";

type AppShellProps = {
  title: string;
  brand?: string;
  eyebrow?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
};

export function AppShell({ title, brand = "Build a Sentence", eyebrow, action, children }: AppShellProps) {
  return (
    <main className="min-h-screen">
      <header className="border-b border-line bg-white/80">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-4">
          <Link href="/" className="font-semibold tracking-wide text-ocean">
            {brand}
          </Link>
          {action}
        </div>
      </header>
      <section className="mx-auto w-full max-w-6xl px-5 py-8">
        {eyebrow ? (
          <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-coral">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="mb-6 text-3xl font-bold">{title}</h1>
        {children}
      </section>
    </main>
  );
}
