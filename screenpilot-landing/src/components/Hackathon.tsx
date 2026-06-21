"use client";

import { motion } from "framer-motion";
import { Award, Cpu, Lightbulb } from "lucide-react";

export default function Hackathon() {
  return (
    <section className="relative py-20 bg-white border-t border-black/[0.05]">
      <div className="max-w-[1280px] mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="rounded-2xl border border-[#2563EB]/15 bg-[#EBF3FE]/40 p-8 md:p-10 overflow-hidden relative"
        >
          <div className="relative grid grid-cols-1 md:grid-cols-3 gap-8 items-start">
            {/* Left */}
            <div className="flex flex-col items-start gap-3">
              <div className="flex items-center gap-2.5 px-3.5 py-1.5 rounded-full border border-[#2563EB]/20 bg-white">
                <Award className="w-4 h-4 text-[#2563EB]" />
                <span className="text-xs font-semibold text-[#2563EB]">
                  Hackathon Submission
                </span>
              </div>
              <h2 className="text-2xl font-bold text-[#0F172A] tracking-tight leading-tight">
                Built for Open Innovation
              </h2>
              <p className="text-[#64748B] text-sm leading-relaxed">
                ScreenPilot was designed and built during a hackathon. The idea was
                simple: what if your browser could just show you what to click?
              </p>
            </div>

            {/* Cards */}
            <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-5 rounded-xl bg-white border border-black/[0.07]">
                <div className="flex items-center gap-2.5 mb-3">
                  <div className="w-7 h-7 rounded-lg bg-[#EBF3FE] flex items-center justify-center">
                    <Cpu className="w-3.5 h-3.5 text-[#2563EB]" />
                  </div>
                  <span className="text-xs font-semibold text-[#0F172A] uppercase tracking-wide">
                    Theme
                  </span>
                </div>
                <p className="text-sm text-[#64748B] leading-relaxed">
                  Open Innovation + Multimodal AI
                </p>
                <p className="text-xs text-[#94A3B8] mt-1.5">
                  Using Gemini&apos;s vision to solve a genuine everyday friction — not a toy problem.
                </p>
              </div>

              <div className="p-5 rounded-xl bg-white border border-black/[0.07]">
                <div className="flex items-center gap-2.5 mb-3">
                  <div className="w-7 h-7 rounded-lg bg-[#ECFDF5] flex items-center justify-center">
                    <Lightbulb className="w-3.5 h-3.5 text-[#10B981]" />
                  </div>
                  <span className="text-xs font-semibold text-[#0F172A] uppercase tracking-wide">
                    Focus
                  </span>
                </div>
                <p className="text-sm text-[#64748B] leading-relaxed">
                  Making software easier to use for everyone
                </p>
                <p className="text-xs text-[#94A3B8] mt-1.5">
                  New hires, non-technical users, anyone stuck in an unfamiliar tool.
                </p>
              </div>

              <div className="sm:col-span-2 p-5 rounded-xl bg-white border border-black/[0.07]">
                <p className="text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-3">
                  Tech Stack
                </p>
                <div className="flex flex-wrap gap-2">
                  {[
                    "Chrome Extensions MV3",
                    "Gemini 2.5 Flash",
                    "Vanilla JavaScript",
                    "DOM APIs",
                    "captureVisibleTab",
                    "OffscreenCanvas",
                    "Next.js 15",
                    "Tailwind CSS",
                  ].map((tech) => (
                    <span
                      key={tech}
                      className="px-2.5 py-1 text-xs text-[#64748B] border border-black/[0.07] rounded-md bg-[#F8FAFC] font-mono"
                    >
                      {tech}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
