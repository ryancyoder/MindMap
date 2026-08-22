import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MindMap",
  description: "Draw mind maps with Apple Pencil. Reads and writes open .canvas files.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "MindMap", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Edge-to-edge on iPad, so the canvas runs under the rounded corners and the
  // home indicator instead of stopping at a letterbox.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f5f3" },
    { media: "(prefers-color-scheme: dark)", color: "#16161a" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
