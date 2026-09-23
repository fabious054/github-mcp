import type { Metadata } from "next";
import "./globals.css";

const SITE_URL = "https://github-mcp-seven.vercel.app";
const TITLE = "GitHub MCP — Real GitHub access for Claude";
const DESCRIPTION =
  "An MCP server that gives Claude real GitHub access: branches, commits, pull requests, issues, and code search — authorized with your own GitHub login, never a shared token.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s · GitHub MCP",
  },
  description: DESCRIPTION,
  keywords: [
    "MCP",
    "Model Context Protocol",
    "Claude",
    "GitHub",
    "GitHub OAuth",
    "Claude connector",
    "AI coding agent",
  ],
  authors: [{ name: "Fabio", url: "https://github.com/fabious054" }],
  category: "technology",
  alternates: {
    canonical: SITE_URL,
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: "GitHub MCP",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
    },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
