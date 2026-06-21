"use client";

import { motion } from "framer-motion";
import { Check, X, Minus } from "lucide-react";

type Status = "yes" | "no" | "partial";

const rows: {
  feature: string;
  tutorials: Status;
  chatbots: Status;
  screenpilot: Status;
}[] = [
  {
    feature: "Sees what's on your screen right now",
    tutorials: "no",
    chatbots: "no",
    screenpilot: "yes",
  },
  {
    feature: "Adjusts after every click",
    tutorials: "no",
    chatbots: "no",
    screenpilot: "yes",
  },
  {
    feature: "Stays inside the application",
    tutorials: "no",
    chatbots: "no",
    screenpilot: "yes",
  },
  {
    feature: "Shows exactly what to click",
    tutorials: "partial",
    chatbots: "no",
    screenpilot: "yes",
  },
  {
    feature: "No setup needed per app",
    tutorials: "no",
    chatbots: "partial",
    screenpilot: "yes",
  },
  {
    feature: "Works without copy-pasting screenshots",
    tutorials: "no",
    chatbots: "no",
    screenpilot: "yes",
  },
];

function StatusIcon({ status }: { status: Status }) {
  if (status === "yes")
    return (
      <div className="flex items-center justify-center">
        <div className="w-6 h-6 rounded-full bg-[#DCFCE7] flex items-center justify-center">
          <Check className="w-3.5 h-3.5 text-[#16A34A]" />
        </div>
      </div>
    );
  if (status === "partial")
    return (
      <div className="flex items-center justify-center">
        <div className="w-6 h-6 rounded-full bg-[#FEF9C3] flex items-center justify-center">
          <Minus className="w-3.5 h-3.5 text-[#CA8A04]" />
        </div>
      </div>
    );
  return (
    <div className="flex items-center justify-center">
      <div className="w-6 h-6 rounded-full bg-[#FEE2E2] flex items-center justify-center">
        <X className="w-3.5 h-3.5 text-[#DC2626]" />
      </div>
    </div>
  );
}

export default function WhyDifferent() {
  return (
    <section
      id="why-different"
      className="relative py-32 bg-[#F8FAFC] border-t border-black/[0.05]"
    >
      <div className="max-w-[1280px] mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center max-w-2xl mx-auto mb-16"
        >
          <p className="text-[11px] text-[#2563EB] uppercase tracking-[0.12em] font-semibold mb-4">
            Comparison
          </p>
          <h2 className="text-4xl md:text-5xl font-bold text-[#0F172A] tracking-tight mb-4">
            Why ScreenPilot is different
          </h2>
          <p className="text-[#64748B] text-lg leading-relaxed">
            Tutorials tell you what was true when they were recorded. Chatbots describe steps without seeing your screen. ScreenPilot is actually watching and guiding.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="max-w-3xl mx-auto rounded-2xl overflow-hidden border border-black/[0.07] bg-white shadow-sm"
        >
          {/* Header */}
          <div className="grid grid-cols-4 border-b border-black/[0.06] bg-[#F8FAFC]">
            <div className="p-5 text-left">
              <span className="text-xs text-[#64748B] font-medium uppercase tracking-wide">
                Capability
              </span>
            </div>
            {[
              { label: "Tutorials", muted: true },
              { label: "Chatbots", muted: true },
              { label: "ScreenPilot", muted: false },
            ].map((col) => (
              <div
                key={col.label}
                className={`p-5 text-center border-l border-black/[0.05] ${!col.muted ? "bg-[#EBF3FE]" : ""}`}
              >
                <span className={`text-sm font-semibold ${col.muted ? "text-[#64748B]" : "text-[#2563EB]"}`}>
                  {col.label}
                </span>
              </div>
            ))}
          </div>

          {rows.map((row, i) => (
            <div
              key={row.feature}
              className={`grid grid-cols-4 border-b border-black/[0.04] last:border-0 hover:bg-[#F8FAFC] transition-colors ${i % 2 === 0 ? "" : "bg-[#FAFAFA]"}`}
            >
              <div className="p-4 flex items-center">
                <span className="text-sm text-[#64748B]">{row.feature}</span>
              </div>
              <div className="p-4 border-l border-black/[0.04] flex items-center justify-center">
                <StatusIcon status={row.tutorials} />
              </div>
              <div className="p-4 border-l border-black/[0.04] flex items-center justify-center">
                <StatusIcon status={row.chatbots} />
              </div>
              <div className="p-4 border-l border-black/[0.04] bg-[#EBF3FE]/50 flex items-center justify-center">
                <StatusIcon status={row.screenpilot} />
              </div>
            </div>
          ))}
        </motion.div>

        <div className="flex items-center justify-center gap-6 mt-6">
          {[
            { status: "yes" as Status, label: "Yes" },
            { status: "partial" as Status, label: "Sort of" },
            { status: "no" as Status, label: "No" },
          ].map(({ status, label }) => (
            <div key={label} className="flex items-center gap-2">
              <StatusIcon status={status} />
              <span className="text-xs text-[#64748B]">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
