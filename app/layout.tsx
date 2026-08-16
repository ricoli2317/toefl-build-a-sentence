import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TPS · TOEFL Practice System",
  description: "TOEFL writing and language practice system"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-paper text-ink antialiased">{children}</body>
    </html>
  );
}
