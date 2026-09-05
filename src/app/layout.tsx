import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ScreenPilot — Navigate Any Software Without Getting Stuck",
  description:
    "ScreenPilot is an AI copilot that understands what's on your screen and guides you through software step-by-step. No tutorials, no documentation searches.",
  keywords: [
    "AI assistant",
    "Chrome Extension",
    "software navigation",
    "multimodal AI",
    "productivity",
    "screen guidance",
    "AI copilot",
  ],
  authors: [{ name: "ScreenPilot" }],
  openGraph: {
    title: "ScreenPilot — Navigate Any Software Without Getting Stuck",
    description:
      "AI copilot that watches your screen, understands your goal, and shows exactly what to click next.",
    type: "website",
    siteName: "ScreenPilot",
  },
  twitter: {
    card: "summary_large_image",
    title: "ScreenPilot — Navigate Any Software Without Getting Stuck",
    description:
      "AI copilot that watches your screen, understands your goal, and shows exactly what to click next.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-white text-[#0F172A]">{children}</body>
    </html>
  );
}
