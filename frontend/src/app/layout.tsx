import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { siteUrl, siteConfig } from "@/lib/site";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const ogTitle = "ProxMate — Invite-only cloud for your Proxmox cluster";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: siteConfig.name,
  title: {
    default: ogTitle,
    template: "%s · ProxMate",
  },
  description: siteConfig.description,
  authors: [{ name: siteConfig.name }],
  creator: siteConfig.name,
  publisher: siteConfig.name,
  alternates: { canonical: "/" },
  // Private control plane — keep it out of search (the meta half; robots.ts is
  // the crawler half). Shareability is unaffected: preview bots ignore robots.
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
  // og/twitter IMAGES come from the opengraph-image.png / twitter-image.png
  // file conventions (with their .alt.txt) — Next merges them in, so we only
  // set the text fields here to avoid duplicate <meta> tags.
  openGraph: {
    type: "website",
    siteName: siteConfig.name,
    title: ogTitle,
    description: siteConfig.shortDescription,
    url: "/",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: ogTitle,
    description: siteConfig.shortDescription,
  },
  appleWebApp: {
    capable: true,
    title: siteConfig.name,
    statusBarStyle: "black-translucent",
  },
  // Stop iOS Safari auto-linkifying numeric strings (VM IDs, IPs) as phone numbers.
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0d1013" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
  colorScheme: "dark light",
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
