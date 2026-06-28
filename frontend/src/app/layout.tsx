import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ProxMate",
  description: "A lightweight, invite-only cloud dashboard for Proxmox VE.",
};

// The nonce CSP (proxy.ts) injects a per-request nonce into framework/bundle
// <script> tags during SSR — which only happens for dynamically rendered pages.
// Force dynamic rendering app-wide so every page's scripts carry the nonce
// (static prerenders would ship un-nonced scripts that 'strict-dynamic' blocks).
// These are client-rendered dashboard pages, so there's no meaningful SSG cache
// to lose.
export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The per-request CSP nonce (set by proxy.ts). Pass it to next-themes so its
  // no-flash inline theme script carries the nonce instead of being CSP-blocked.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange nonce={nonce}>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
