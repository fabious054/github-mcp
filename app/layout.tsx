import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GitHub MCP",
  description:
    "Real GitHub access for Claude — branches, commits, pull requests, issues, and code search, authorized with your own GitHub login.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
