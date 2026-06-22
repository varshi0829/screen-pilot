"use client";

import { motion } from "framer-motion";
import { Play, Github, ArrowRight } from "lucide-react";

const trustItems = [
  "Gmail",
  "GitHub",
  "Jira",
  "Notion",
  "Salesforce",
  "University Portals",
];

export default function Hero() {
  return (
    <section
      id="hero"
      className="relative min-h-screen flex items-center pt-16 overflow-hidden bg-white"
    >
      {/* Very subtle grid */}
      <div className="absolute inset-0 bg-grid" />
      {/* Blue glow top center */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-[#2563EB]/[0.04] rounded-full blur-[100px] pointer-events-none" />

      <div className="relative max-w-[1280px] mx-auto px-6 py-24 grid grid-cols-1 lg:grid-cols-2 gap-16 items-center w-full">
        {/* Left column */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="flex flex-col gap-7"
        >
          {/* Badge */}
          <div className="inline-flex items-center gap-2.5 self-start px-3.5 py-1.5 rounded-full border border-black/[0.08] bg-black/[0.02] text-xs text-[#64748B] font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-[#2563EB]" />
            Chrome Extension
            <span className="text-black/20">·</span>
            <span className="text-[#10B981] font-semibold">Gemini 2.5 Flash</span>
          </div>

          {/* Headline */}
          <div>
            <h1 className="text-5xl lg:text-6xl xl:text-[64px] font-bold text-[#0F172A] leading-[1.06] tracking-tight">
              Navigate Any
              <br />
              Software
              <br />
              <span className="text-[#2563EB]">Without Getting Stuck</span>
            </h1>
          </div>

          {/* Subheadline — accurate to what the product actually does */}
          <p className="text-lg text-[#64748B] leading-relaxed max-w-md">
            Open ScreenPilot on any tab. Type what you want to do. It captures
            the page, thinks through the steps, and puts a pulsing highlight on
            exactly what to click next.
          </p>

          {/* 3-step install flow */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <a
                href="/screenpilot-extension.zip"
                download="screenpilot-extension.zip"
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-semibold rounded-lg transition-colors shadow-lg shadow-blue-200"
              >
                <Github className="w-4 h-4" />
                1. Install Extension
              </a>
              <a
                href="#demo"
                className="inline-flex items-center gap-2 px-5 py-2.5 border border-black/[0.1] text-[#0F172A] text-sm font-semibold rounded-lg hover:bg-black/[0.03] transition-colors"
              >
                <Play className="w-4 h-4 fill-current text-[#2563EB]" />
                See a Demo
              </a>
            </div>
            <div className="flex items-start gap-6 pt-1">
              <div className="flex items-center gap-2 text-xs text-[#64748B]">
                <span className="w-5 h-5 rounded-full bg-[#F1F5F9] border border-black/[0.07] flex items-center justify-center text-[10px] font-bold text-[#2563EB]">2</span>
                Open ScreenPilot on any tab
              </div>
              <div className="flex items-center gap-2 text-xs text-[#64748B]">
                <span className="w-5 h-5 rounded-full bg-[#F1F5F9] border border-black/[0.07] flex items-center justify-center text-[10px] font-bold text-[#2563EB]">3</span>
                Type your goal — done
              </div>
            </div>
            <p className="text-[11px] text-[#10B981] font-medium">
              No API key needed. No account. Works instantly.
            </p>
          </div>

          {/* Trust indicators */}
          <div className="space-y-2.5">
            <p className="text-[11px] text-[#64748B] uppercase tracking-[0.12em] font-semibold">
              Works on
            </p>
            <div className="flex flex-wrap gap-2">
              {trustItems.map((item) => (
                <span
                  key={item}
                  className="px-3 py-1 text-xs text-[#64748B] border border-black/[0.07] rounded-full bg-black/[0.02]"
                >
                  {item}
                </span>
              ))}
              <span className="px-3 py-1 text-xs text-[#2563EB] font-medium border border-[#2563EB]/20 rounded-full bg-[#2563EB]/[0.04]">
                + any website
              </span>
            </div>
          </div>
        </motion.div>

        {/* Right column: browser mockup */}
        <motion.div
          initial={{ opacity: 0, x: 32 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.7, delay: 0.15 }}
          className="relative"
        >
          <BrowserMockup />
        </motion.div>
      </div>
    </section>
  );
}

function BrowserMockup() {
  return (
    <div
      className="relative rounded-xl overflow-hidden border border-black/[0.09] bg-[#F8FAFC]"
      style={{ boxShadow: "0 20px 60px rgba(0,0,0,0.10), 0 4px 16px rgba(0,0,0,0.06)" }}
    >
      {/* Browser chrome */}
      <div className="bg-[#EBEDF0] px-4 py-3 flex items-center gap-3 border-b border-black/[0.08]">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-400" />
          <div className="w-3 h-3 rounded-full bg-yellow-400" />
          <div className="w-3 h-3 rounded-full bg-green-400" />
        </div>
        <div className="flex-1 bg-white rounded-md px-3 py-1.5 text-xs text-[#64748B] font-mono border border-black/[0.06]">
          mail.google.com/mail/u/0/#inbox
        </div>
      </div>

      {/* Gmail top bar */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-black/[0.05] bg-white">
        <span className="text-sm font-medium text-[#0F172A]">
          <span className="text-[#2563EB] font-bold">M</span> Gmail
        </span>
        <div className="flex-1 bg-[#F1F3F4] rounded-full px-3 py-1.5 text-xs text-[#64748B]">
          Search mail
        </div>
      </div>

      {/* Gmail body */}
      <div className="flex h-52">
        {/* Sidebar */}
        <div className="w-40 border-r border-black/[0.05] p-2.5 flex flex-col gap-0.5 bg-white flex-shrink-0">
          {/* Compose — highlighted */}
          <div className="relative flex items-center gap-2 px-3 py-2 rounded-2xl bg-[#2563EB]/10 border border-[#2563EB]/30 text-[#2563EB] text-xs font-semibold mb-1.5 cursor-pointer">
            <motion.div
              className="absolute inset-0 rounded-2xl border-2 border-[#2563EB]/50"
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
            <svg className="w-3 h-3 fill-[#2563EB] flex-shrink-0" viewBox="0 0 24 24">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
            </svg>
            Compose
          </div>

          {[["Inbox", "23"], ["Starred", ""], ["Sent", ""], ["Drafts", "2"], ["More", ""]].map(([label, count]) => (
            <div key={label} className="flex items-center gap-2 px-3 py-1.5 text-[#64748B] text-xs rounded-md hover:bg-black/[0.03] cursor-pointer">
              <span className="flex-1">{label}</span>
              {count && <span className="text-[#2563EB] font-medium">{count}</span>}
            </div>
          ))}
        </div>

        {/* Inbox list */}
        <div className="flex-1 flex flex-col bg-white overflow-hidden">
          {[
            { from: "GitHub", subject: "PR review requested: screen-pilot", time: "9:41 AM", unread: true },
            { from: "Vercel", subject: "Deployment successful", time: "Yesterday", unread: false },
            { from: "Google Cloud", subject: "Gemini API usage summary", time: "Mon", unread: false },
            { from: "Team", subject: "Sprint planning notes", time: "Jun 18", unread: false },
          ].map((email, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 px-4 py-2.5 border-b border-black/[0.04] cursor-pointer hover:bg-[#F8FAFC] ${email.unread ? "bg-[#EBF3FE]/40" : ""}`}
            >
              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${email.unread ? "bg-[#2563EB]" : "bg-transparent"}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-xs truncate ${email.unread ? "text-[#0F172A] font-semibold" : "text-[#64748B]"}`}>{email.from}</span>
                  <span className="text-[10px] text-[#94A3B8] flex-shrink-0 font-mono">{email.time}</span>
                </div>
                <p className="text-[11px] text-[#94A3B8] truncate mt-0.5">{email.subject}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ScreenPilot widget — bottom right, as it actually appears */}
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ delay: 0.9, duration: 0.4, ease: "easeOut" }}
        className="absolute bottom-3 right-3 w-52 bg-white border border-black/[0.1] rounded-xl p-3.5"
        style={{ boxShadow: "0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)" }}
      >
        <div className="flex items-center gap-2 mb-2.5">
          <div className="w-5 h-5 rounded-full bg-[#2563EB] flex items-center justify-center flex-shrink-0">
            <ArrowRight className="w-2.5 h-2.5 text-white" />
          </div>
          <span className="text-xs font-semibold text-[#0F172A]">ScreenPilot</span>
          <span className="ml-auto text-[10px] text-[#64748B] font-mono bg-[#F8FAFC] px-1.5 py-0.5 rounded border border-black/[0.06]">
            1/3
          </span>
        </div>
        <p className="text-[11px] text-[#64748B] leading-relaxed mb-3">
          Click <span className="text-[#2563EB] font-semibold">Compose</span> in the sidebar to start your email.
        </p>
        <div className="w-full h-1 bg-[#F1F5F9] rounded-full overflow-hidden">
          <motion.div
            className="h-1 bg-[#2563EB] rounded-full"
            initial={{ width: "0%" }}
            animate={{ width: "33%" }}
            transition={{ delay: 1.2, duration: 0.7, ease: "easeOut" }}
          />
        </div>
      </motion.div>
    </div>
  );
}
